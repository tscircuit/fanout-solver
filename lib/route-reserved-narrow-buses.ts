import { getCornerBandSide } from "./boundary-exit"
import { getFreeBoundaryTracks } from "./get-free-boundary-tracks"
import { routeViaMinimalWindingAlternativesSteps } from "./route-via-minimal-winding"
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
  // Commit the most constrained corner exits first, then sweep across the
  // source field. Two complete greedy orders cheaply resolve cases where the
  // recursive search otherwise spends its budget revisiting center lanes.
  if (params.buses.length > 1) {
    for (const sign of [1, -1]) {
      const sweep = params.buses.toSorted((a, b) => {
        const aCorner =
          getCornerBandSide(a.exitEdge, a.preferredExit) !== undefined
        const bCorner =
          getCornerBandSide(b.exitEdge, b.preferredExit) !== undefined
        if (aCorner !== bCorner) return Number(bCorner) - Number(aCorner)
        const axis = a.exitEdge === "left" || a.exitEdge === "right" ? "y" : "x"
        return sign * (sourceMean(a, axis) - sourceMean(b, axis))
      })
      let accepted = [...params.acceptedPlans]
      for (const bus of sweep) {
        const alternatives = yield* route(bus, accepted)
        if (!alternatives.length) {
          accepted = []
          break
        }
        accepted.push(...alternatives[0]!)
      }
      if (accepted.length)
        return restore(accepted.slice(params.acceptedPlans.length))
    }
  }
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
  // An edge-only singleton can reserve a separating channel before the
  // corner-guided pairs. Keep this ordered retry bounded; each bus may also
  // move its complete, ordered track envelope into a free edge interval.
  if (params.buses.length > 1) {
    const intervalOrder = ordered.toSorted((a, b) => {
      const singleton = (bus: PreparedBus) =>
        bus.connections.length === 1 &&
        !getCornerBandSide(bus.exitEdge, bus.preferredExit)
      return Number(singleton(b)) - Number(singleton(a))
    })
    const intervalAttemptLimit = Math.min(maximumAttempts, attempts + 48)
    function* orderedIntervals(
      index: number,
      accepted: FanoutRoutePlan[],
    ): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[] | null, void> {
      if (index === intervalOrder.length) return accepted
      if (attempts >= intervalAttemptLimit) return null
      const bus = intervalOrder[index]!
      const ordinary = yield* route(bus, accepted)
      for (const plans of ordinary) {
        const result = yield* orderedIntervals(index + 1, [
          ...accepted,
          ...plans,
        ])
        if (result) return result
      }
      const alternatives = yield* freeIntervals(
        bus,
        accepted,
        intervalAttemptLimit,
      )
      for (const plans of alternatives) {
        const result = yield* orderedIntervals(index + 1, [
          ...accepted,
          ...plans,
        ])
        if (result) return result
      }
      return null
    }
    const intervalPlans = yield* orderedIntervals(0, [...params.acceptedPlans])
    if (intervalPlans)
      return restore(intervalPlans.slice(params.acceptedPlans.length))
  }
  function* freeIntervals(
    bus: PreparedBus,
    accepted: FanoutRoutePlan[],
    attemptLimit: number,
  ): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[][], void> {
    if (!bus.exitEdge) return []
    const reservedVias = params.reservedVias?.filter(
      (reserved) =>
        !bus.connections.some(
          (connection) =>
            connection.connection.name === reserved.connectionName,
        ),
    )
    const common = { ...params, bus, acceptedPlans: accepted, reservedVias }
    const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    const vertical = bus.exitEdge === "left" || bus.exitEdge === "right"
    const boundary = bus.sharedBoundary
    const lower = vertical ? boundary.minY : boundary.minX
    const upper = vertical ? boundary.maxY : boundary.maxX
    const middle = (lower + upper) / 2
    const alternatives: FanoutRoutePlan[][] = []
    for (const track of getFreeBoundaryTracks(common)) {
      if (attempts >= attemptLimit) break
      const preferredExit = side
        ? bus.preferredExit
        : guidance(bus).find(
            (candidate) =>
              getCornerBandSide(bus.exitEdge, candidate) ===
              (track > middle ? "maximum" : "minimum"),
          )
      const reference = bus.connections.map((connection) =>
        getCornerTargetTrack({
          ...common,
          bus: { ...bus, preferredExit },
          connection,
          cornerExitLaneOffset: 0,
          windingOrderIndex: 0,
        }),
      )
      const mean =
        reference.reduce((sum, value) => sum + value, 0) / reference.length
      const tracks = reference.map((value) => value - mean + track)
      if (
        tracks.some(
          (value) =>
            value <= lower + params.traceWidth / 2 ||
            value >= upper - params.traceWidth / 2 ||
            (side === "minimum" && value >= middle) ||
            (side === "maximum" && value <= middle),
        )
      )
        continue
      const terminals = bus.connections.map((connection, index) => {
        const viaPoint = params.fixedViaPointsByConnectionIndex?.get(
          connection.connectionIndex,
        )
        const along = tracks[index]!
        const exitPoint =
          bus.exitEdge === "left"
            ? { x: boundary.minX, y: along }
            : bus.exitEdge === "right"
              ? { x: boundary.maxX, y: along }
              : bus.exitEdge === "bottom"
                ? { x: along, y: boundary.minY }
                : { x: along, y: boundary.maxY }
        return { connection, viaPoint: viaPoint!, exitPoint }
      })
      if (terminals.some((terminal) => !terminal.viaPoint)) return []
      attempts++
      const steps = routeViaMinimalWindingAlternativesSteps(
        {
          ...common,
          terminals,
          gridStep: pitch / 2,
          alignGridToPads: true,
          maximumRouteOrderAttempts: bus.connections.length === 1 ? 3 : 16,
          adaptiveRouteOrder: true,
        },
        1,
        false,
      )
      let result = steps.next()
      while (!result.done) {
        yield {
          phase: "via-minimal-winding",
          busId: bus.busId,
          targetLayer: params.targetLayer,
          winding: result.value,
        }
        result = steps.next()
      }
      alternatives.push(...result.value)
    }
    return alternatives
  }
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
    // A singleton has no intra-bus track ordering to preserve. If the ordinary
    // bands fail, use free intervals on its original edge and declared half-band.
    for (const bus of remaining) {
      if (bus.connections.length !== 1 || !bus.exitEdge) continue
      const connection = bus.connections[0]!
      const viaPoint = params.fixedViaPointsByConnectionIndex?.get(
        connection.connectionIndex,
      )
      if (!viaPoint) continue
      const reservedVias = params.reservedVias?.filter(
        (reserved) => reserved.connectionName !== connection.connection.name,
      )
      const tracks = getFreeBoundaryTracks({
        ...params,
        bus,
        acceptedPlans: accepted,
        reservedVias,
      })
      for (const track of tracks) {
        if (attempts++ >= maximumAttempts) return null
        const boundary = bus.sharedBoundary
        const exitPoint =
          bus.exitEdge === "left"
            ? { x: boundary.minX, y: track }
            : bus.exitEdge === "right"
              ? { x: boundary.maxX, y: track }
              : bus.exitEdge === "bottom"
                ? { x: track, y: boundary.minY }
                : { x: track, y: boundary.maxY }
        const steps = routeViaMinimalWindingAlternativesSteps(
          {
            ...params,
            bus,
            acceptedPlans: accepted,
            reservedVias,
            terminals: [{ connection, viaPoint, exitPoint }],
            gridStep: pitch / 2,
            alignGridToPads: true,
            maximumRouteOrderAttempts: 3,
          },
          1,
          false,
        )
        let result = steps.next()
        while (!result.done) {
          yield {
            phase: "via-minimal-winding",
            busId: bus.busId,
            targetLayer: params.targetLayer,
            winding: result.value,
          }
          result = steps.next()
        }
        if (!result.value.length) continue
        const complete = yield* search(
          remaining.filter((candidate) => candidate !== bus),
          [...accepted, ...result.value[0]!],
        )
        if (complete) return complete
      }
    }
    return null
  }
  const result = yield* search(ordered, [...params.acceptedPlans])
  return result && restore(result.slice(params.acceptedPlans.length))
}
