import { getCornerBandSide } from "./boundary-exit"
import {
  getCornerTargetTrack,
  routeBusAlternativesSteps,
  type RouteBusAlternativesProgress,
  type RouteBusParams,
} from "./route-bus"
import type { FanoutBorderTarget, FanoutRoutePlan, PreparedBus } from "./types"

interface Params extends Omit<RouteBusParams, "bus"> {
  buses: readonly PreparedBus[]
}

/** Route fixed-via small buses together so an early lane cannot trap a later bus. */
export function* routeReservedNarrowBusesSteps(
  params: Params,
): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[] | null, void> {
  if (
    params.buses.some(
      (bus) =>
        bus.termination.type !== "boundary" || bus.connections.length > 2,
    )
  )
    return null
  let attempts = 0
  const maximumAttempts = 192
  const pitch = params.traceWidth + params.clearance
  function* route(
    bus: PreparedBus,
    accepted: FanoutRoutePlan[],
    preferredExit = bus.preferredExit,
    offset = 0,
  ) {
    if (attempts++ >= maximumAttempts) return []
    return yield* routeBusAlternativesSteps(
      {
        ...params,
        bus: { ...bus, preferredExit },
        acceptedPlans: accepted,
        reservedVias: params.reservedVias?.filter(
          (reserved) =>
            !bus.connections.some(
              (connection) =>
                connection.connection.name === reserved.connectionName,
            ),
        ),
        viaMinimalOnly: true,
        adaptiveWindingRouteOrder: true,
        alignWindingGridToPads: true,
        windingGridStep: pitch / 2,
        fixedViaFallbackRouteOrderAttempts: 32,
        cornerBandTargetTrackOffset: offset,
      },
      1,
      false,
    )
  }
  const restore = (plans: FanoutRoutePlan[]) =>
    plans.map((plan) => {
      const bus = params.buses.find((bus) => bus.busId === plan.busId)
      return bus
        ? {
            ...plan,
            cornerBandSide: getCornerBandSide(bus.exitEdge, bus.preferredExit),
          }
        : plan
    })
  // Retain successful ordinary routing before searching alternate bands/orders.
  let ordinary = [...params.acceptedPlans]
  for (const bus of params.buses) {
    const plans = yield* route(bus, ordinary)
    if (!plans.length) {
      ordinary = []
      break
    }
    ordinary.push(...plans[0]!)
  }
  if (ordinary.length)
    return restore(ordinary.slice(params.acceptedPlans.length))

  const sourceMean = (bus: PreparedBus, axis: "x" | "y") =>
    bus.connections.reduce(
      (sum, c) =>
        sum +
        (params.fixedViaPointsByConnectionIndex?.get(c.connectionIndex) ??
          c.sourcePoint)[axis],
      0,
    ) / bus.connections.length
  const ordered = params.buses.toSorted((a, b) => {
    const aSide = getCornerBandSide(a.exitEdge, a.preferredExit)
    const bSide = getCornerBandSide(b.exitEdge, b.preferredExit)
    const aLower = aSide === "minimum",
      bLower = bSide === "minimum"
    if (aLower !== bLower) return Number(bLower) - Number(aLower)
    if (aLower) return sourceMean(a, "y") - sourceMean(b, "y")
    if (a.connections.length !== b.connections.length)
      return a.connections.length - b.connections.length
    if (a.connections.length === 1)
      return sourceMean(a, "x") - sourceMean(b, "x")
    if (aSide !== bSide)
      return Number(aSide === "maximum") - Number(bSide === "maximum")
    return (
      (aSide === "maximum" ? 1 : -1) * (sourceMean(a, "y") - sourceMean(b, "y"))
    )
  })
  function guidance(bus: PreparedBus): (FanoutBorderTarget | undefined)[] {
    if (getCornerBandSide(bus.exitEdge, bus.preferredExit))
      return [bus.preferredExit]
    switch (bus.exitEdge) {
      case "right":
        return [bus.preferredExit, "top-right", "bottom-right"]
      case "left":
        return [bus.preferredExit, "top-left", "bottom-left"]
      case "top":
        return [bus.preferredExit, "top-left", "top-right"]
      case "bottom":
        return [bus.preferredExit, "bottom-left", "bottom-right"]
      default:
        return [bus.preferredExit]
    }
  }
  function offsets(
    bus: PreparedBus,
    accepted: FanoutRoutePlan[],
    preferredExit: FanoutBorderTarget | undefined,
  ) {
    const side = getCornerBandSide(bus.exitEdge, preferredExit)
    if (!side || params.buses.length > 1) return [0]
    const horizontal = bus.exitEdge === "left" || bus.exitEdge === "right"
    const lower = horizontal ? bus.sharedBoundary.minY : bus.sharedBoundary.minX
    const upper = horizontal ? bus.sharedBoundary.maxY : bus.sharedBoundary.maxX
    const middle = (lower + upper) / 2
    const cornerExitLaneOffset = accepted.filter(
      (plan) => plan.exitEdge === bus.exitEdge && plan.cornerBandSide === side,
    ).length
    const tracks = bus.connections.map((connection) =>
      getCornerTargetTrack({
        ...params,
        bus: { ...bus, preferredExit },
        connection,
        cornerExitLaneOffset,
        windingOrderIndex: 0,
      }),
    )
    const sign = side === "minimum" ? -1 : 1
    const padPitch = Math.min(bus.pitchX, bus.pitchY)
    const mean = tracks.reduce((sum, value) => sum + value, 0) / tracks.length
    const edgeTrack = side === "minimum" ? lower + pitch : upper - pitch
    const candidates = [
      0,
      sign * 2 * pitch,
      -sign * 2 * pitch,
      sign * padPitch,
      sign * 2 * padPitch,
      sign * 3 * padPitch,
      sign * 4 * padPitch,
      edgeTrack - mean,
    ]
    return candidates.filter(
      (offset, i) =>
        candidates.indexOf(offset) === i &&
        tracks.every(
          (track) =>
            track + offset > lower + params.traceWidth / 2 &&
            track + offset < upper - params.traceWidth / 2 &&
            (side === "minimum"
              ? track + offset < middle
              : track + offset > middle),
        ),
    )
  }
  function* search(
    remaining: readonly PreparedBus[],
    accepted: FanoutRoutePlan[],
  ): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[] | null, void> {
    if (!remaining.length) return accepted
    if (attempts >= maximumAttempts) return null
    for (const bus of remaining) {
      for (const preferredExit of guidance(bus)) {
        for (const offset of offsets(bus, accepted, preferredExit)) {
          const alternatives = yield* route(
            bus,
            accepted,
            preferredExit,
            offset,
          )
          if (!alternatives.length) continue
          const result = yield* search(
            remaining.filter((candidate) => candidate !== bus),
            [...accepted, ...alternatives[0]!],
          )
          if (result) return result
          if (attempts >= maximumAttempts) return null
        }
      }
    }
    return null
  }
  const result = yield* search(ordered, [...params.acceptedPlans])
  return result && restore(result.slice(params.acceptedPlans.length))
}
