import { getCornerBandSide, getDirectionForExitEdge } from "./boundary-exit"
import { getFreeBoundaryTracks } from "./get-free-boundary-tracks"
import {
  fanoutPlansAreClear,
  getBoundaryTargetTrack,
  getCornerTargetTrack,
  type RouteBusAlternativesProgress,
  type RouteBusParams,
} from "./route-bus"
import { chamferSplitPerimeter } from "./route-split-perimeter-source-escapes"
import {
  routeViaMinimalWindingAlternativesSteps,
  type ViaMinimalWindingTerminal,
} from "./route-via-minimal-winding"
import type { FanoutRoutePlan, PreparedBus } from "./types"

interface Params extends Omit<RouteBusParams, "bus"> {
  buses: readonly PreparedBus[]
  /** Include pending source copper, including other members of this group. */
  sourcePlans: readonly FanoutRoutePlan[]
}

function hasSharpTurn(plan: FanoutRoutePlan): boolean {
  return plan.segments.some((segment, index) => {
    const previous = plan.segments[index - 1]
    if (!previous || previous.layer !== segment.layer) return false
    const dx = segment.end.x - segment.start.x
    const dy = segment.end.y - segment.start.y
    const px = previous.end.x - previous.start.x
    const py = previous.end.y - previous.start.y
    const lengths = Math.hypot(dx, dy) * Math.hypot(px, py)
    return (
      lengths > 1e-12 && (dx * px + dy * py) / lengths < Math.SQRT1_2 - 1e-7
    )
  })
}

/** Explicit grid terminals can leave a tiny right-angle join at the boundary. */
function normalizeTargetCorners(plan: FanoutRoutePlan): FanoutRoutePlan | null {
  if (!hasSharpTurn(plan)) return plan
  if (
    !plan.via ||
    plan.additionalVias?.length ||
    plan.planeEndpointSegments?.length
  )
    return null
  const count = plan.sourceEscapeSegmentCount ?? 1
  const tail = plan.segments.slice(count)
  if (
    !tail.length ||
    tail.some((segment) => segment.layer !== plan.targetLayer)
  )
    return null
  const points = chamferSplitPerimeter(
    [tail[0]!.start, ...tail.map((segment) => segment.end)],
    tail[0]!.width,
  )
  const segments = [
    ...plan.segments.slice(0, count),
    ...points.slice(1).map((end, index) => ({
      start: points[index]!,
      end,
      width: tail[0]!.width,
      layer: plan.targetLayer,
    })),
  ]
  const firstVia = plan.trace.route.findIndex(
    (point) => point.route_type === "via",
  )
  if (firstVia < 0) return null
  const candidate: FanoutRoutePlan = {
    ...plan,
    segments,
    length: segments.reduce(
      (sum, segment) =>
        sum +
        Math.hypot(
          segment.end.x - segment.start.x,
          segment.end.y - segment.start.y,
        ),
      0,
    ),
    trace: {
      ...plan.trace,
      route: [
        ...plan.trace.route.slice(0, firstVia + 1),
        ...points.map((point) => ({
          route_type: "wire" as const,
          ...point,
          width: tail[0]!.width,
          layer: plan.targetLayer,
        })),
      ],
    },
  }
  return hasSharpTurn(candidate) ? null : candidate
}

/** Bounded ordered winding and free-edge translations before broader search. */
export function* routeNarrowWindingPreflightSteps(
  params: Params,
): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[] | null, void> {
  if (
    params.buses.length === 0 ||
    params.buses.some(
      (bus) =>
        bus.termination.type !== "boundary" ||
        !bus.exitEdge ||
        bus.connections.length < 1 ||
        bus.connections.length > 2 ||
        bus.connections.some(
          (connection) =>
            !params.fixedViaPointsByConnectionIndex?.has(
              connection.connectionIndex,
            ) || !params.sourceEscapePaths?.has(connection.connectionIndex),
        ),
    )
  )
    return null
  const reserved = new Map(
    params.sourcePlans.map((plan) => [plan.connectionIndex, plan]),
  )
  for (const plan of params.acceptedPlans)
    reserved.set(plan.connectionIndex, plan)
  let attempts = 0
  function* routeRemaining(
    index: number,
    routed: FanoutRoutePlan[],
  ): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[] | null, void> {
    if (index === params.buses.length) return routed
    const bus = params.buses[index]!
    const working = new Map(reserved)
    for (const plan of routed) working.set(plan.connectionIndex, plan)
    const own = new Set(bus.connections.map((c) => c.connectionIndex))
    const acceptedPlans = [...working.values()].filter(
      (plan) => !own.has(plan.connectionIndex),
    )
    const routeParams = { ...params, bus, acceptedPlans }
    const edge = bus.exitEdge!
    const axis = edge === "left" || edge === "right" ? "y" : "x"
    const side = getCornerBandSide(edge, bus.preferredExit)
    const boundary = bus.sharedBoundary
    const minimum = axis === "x" ? boundary.minX : boundary.minY
    const maximum = axis === "x" ? boundary.maxX : boundary.maxY
    const middle = (minimum + maximum) / 2
    const lower =
      (side === "maximum" ? middle : minimum) + params.traceWidth / 2
    const upper =
      (side === "minimum" ? middle : maximum) - params.traceWidth / 2
    const terminals: ViaMinimalWindingTerminal[] = bus.connections.map(
      (connection) => {
        const track = side
          ? getCornerTargetTrack({
              ...routeParams,
              connection,
              cornerExitLaneOffset: 0,
            })
          : getBoundaryTargetTrack({
              ...routeParams,
              connection,
              boundaryDirection: getDirectionForExitEdge(edge),
            })
        return {
          connection,
          viaPoint: params.fixedViaPointsByConnectionIndex!.get(
            connection.connectionIndex,
          )!,
          exitPoint:
            edge === "left"
              ? { x: boundary.minX, y: track }
              : edge === "right"
                ? { x: boundary.maxX, y: track }
                : edge === "top"
                  ? { x: track, y: boundary.maxY }
                  : { x: track, y: boundary.minY },
        }
      },
    )
    const mean =
      terminals.reduce((sum, terminal) => sum + terminal.exitPoint[axis], 0) /
      terminals.length
    // Translating the complete envelope retains its original lane ordering and
    // spacing. Reject centers whose full envelope would leave the declared band.
    const offsets = [
      0,
      ...getFreeBoundaryTracks(routeParams)
        .slice(0, 4)
        .map((track) => track - mean),
    ]
    for (const offset of offsets) {
      const translated = terminals.map((terminal) => ({
        ...terminal,
        exitPoint: {
          ...terminal.exitPoint,
          [axis]: terminal.exitPoint[axis] + offset,
        },
      }))
      if (
        translated.some(
          (terminal) =>
            terminal.exitPoint[axis] < lower - 1e-7 ||
            terminal.exitPoint[axis] > upper + 1e-7,
        )
      )
        continue
      if (attempts++ >= 48) return null
      const steps = routeViaMinimalWindingAlternativesSteps(
        {
          ...routeParams,
          terminals: translated,
          gridStep: params.traceWidth,
          alignGridToPads: true,
          maximumRouteOrderAttempts: 4,
        },
        1,
        false,
      )
      let step = steps.next()
      while (!step.done) {
        yield {
          phase: "via-minimal-winding",
          busId: bus.busId,
          targetLayer: params.targetLayer,
          winding: step.value,
        }
        step = steps.next()
      }
      const raw = step.value[0]
      if (!raw) continue
      const normalized = raw.map(normalizeTargetCorners)
      if (normalized.some((plan) => plan === null)) continue
      const complete = normalized as FanoutRoutePlan[]
      if (
        complete.some((plan, index) => plan !== raw[index]) &&
        !fanoutPlansAreClear({
          ...routeParams,
          plans: [...acceptedPlans, ...complete],
          sharedBoundary: bus.sharedBoundary,
        })
      )
        continue
      const result = yield* routeRemaining(index + 1, [...routed, ...complete])
      if (result) return result
    }
    return null
  }
  return yield* routeRemaining(0, [])
}
