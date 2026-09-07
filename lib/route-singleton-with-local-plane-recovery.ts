import { getCornerBandSide, getDirectionForExitEdge } from "./boundary-exit"
import { distancePointToSegment } from "./geometry"
import { getFreeBoundaryTracks } from "./get-free-boundary-tracks"
import { plansPreserveSourcesAndCorners } from "./plans-preserve-sources-and-corners"
import {
  fanoutPlansAreClear,
  getBoundaryTargetTrack,
  getCornerTargetTrack,
  type RouteBusParams,
} from "./route-bus"
import {
  type NativePlaneRecoveryResult,
  routeBusWithNativePlaneRecoverySteps,
} from "./route-bus-with-native-plane-recovery"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import { chamferSplitPerimeter } from "./route-split-perimeter-source-escapes"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type { PreparedBus } from "./types"

interface Params extends RouteBusParams {
  preparedBuses: readonly PreparedBus[]
  sourceEscapes: readonly PeripheralSourceEscape[]
}

/** Open one enclosed singleton by jointly replacing a nearby boundary lane.
 * Accepted bus endpoints stay fixed; original source and shape guards apply to
 * the entire returned layout. The caller must rerun complete bus length matching.
 */
export function* routeSingletonWithLocalPlaneRecoverySteps(
  params: Params,
): Generator<unknown, NativePlaneRecoveryResult | null, void> {
  const { bus } = params
  if (
    bus.termination.type !== "boundary" ||
    bus.connections.length !== 1 ||
    !bus.exitEdge ||
    params.allowSameNetMerges ||
    params.allowBlindAndBuriedVias
  )
    return null
  const connection = bus.connections[0]!
  const source = params.sourceEscapes.find(
    (e) => e.connectionIndex === connection.connectionIndex,
  )
  if (!source) throw Error("Singleton recovery requires its reserved source")
  const holders = new Map(
    params.preparedBuses.flatMap((owner) =>
      owner.connections.map(
        (c) => [c.connectionIndex, { bus: owner, connection: c }] as const,
      ),
    ),
  )
  const accepted = params.acceptedPlans.filter(
    (p) => p.connectionIndex !== connection.connectionIndex,
  )
  const candidates = accepted
    .filter((plan) => {
      const owner = holders.get(plan.connectionIndex)
      return (
        owner &&
        plan.termination.type === "boundary" &&
        plan.targetLayer === params.targetLayer &&
        owner.bus.componentId === bus.componentId &&
        owner.bus.exitEdge === bus.exitEdge &&
        getCornerBandSide(owner.bus.exitEdge!, owner.bus.preferredExit) ===
          getCornerBandSide(bus.exitEdge!, bus.preferredExit)
      )
    })
    .map((plan) => ({
      plan,
      distance: Math.min(
        ...plan.segments
          .filter((segment) => segment.layer === params.targetLayer)
          .map((segment) =>
            distancePointToSegment(
              source.via.center,
              segment.start,
              segment.end,
            ),
          ),
      ),
    }))
    .toSorted(
      (a, b) =>
        a.distance - b.distance ||
        a.plan.connectionIndex - b.plan.connectionIndex,
    )
    .slice(0, 8)
  const primaryTrack = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    ? getCornerTargetTrack({ ...params, connection, cornerExitLaneOffset: 0 })
    : getBoundaryTargetTrack({
        ...params,
        connection,
        boundaryDirection: getDirectionForExitEdge(bus.exitEdge),
      })
  const tracks = [
    ...new Set([
      primaryTrack,
      ...getFreeBoundaryTracks({ ...params, acceptedPlans: accepted }),
    ]),
  ]
  let attempts = 0
  for (const { plan: blocker } of candidates) {
    const owner = holders.get(blocker.connectionIndex)!
    if (!blocker.via) continue
    const group = { ...owner.bus, connections: [owner.connection, connection] }
    for (const track of tracks) {
      if (attempts++ >= 64) return null
      const b = bus.sharedBoundary
      const exitPoint =
        bus.exitEdge === "left"
          ? { x: b.minX, y: track }
          : bus.exitEdge === "right"
            ? { x: b.maxX, y: track }
            : bus.exitEdge === "top"
              ? { x: track, y: b.maxY }
              : { x: track, y: b.minY }
      const terminal = { connection, viaPoint: source.via.center, exitPoint }
      const result = yield* routeBusWithNativePlaneRecoverySteps({
        ...params,
        bus: group,
        acceptedPlans: accepted.filter(
          (p) => p.connectionIndex !== blocker.connectionIndex,
        ),
        initialPlans: [blocker],
        terminals: [
          {
            connection: owner.connection,
            viaPoint: blocker.via.center,
            exitPoint: blocker.exitPoint,
          },
          terminal,
        ],
        gridStep: params.traceWidth,
        gridStepDivisor: 2,
        alignGridToPads: true,
        routeOrder: [0, 1],
        maximumRouteOrderAttempts: 32,
        maximumFeedbackRounds: 4,
        adaptiveRouteOrder: true,
        reserveTerminalExitPoints: true,
      })
      if (!result) continue
      const raw = result.plans.find(
        (p) => p.connectionIndex === connection.connectionIndex,
      )!
      const updated = result.sourceEscapes.find(
        (e) => e.connectionIndex === connection.connectionIndex,
      )!
      if (raw.additionalVias?.length || raw.planeEndpointSegments?.length)
        continue
      const tail = raw.segments.slice(raw.sourceEscapeSegmentCount ?? 1)
      if (!tail.length || tail.some((s) => s.layer !== params.targetLayer))
        continue
      const targetLayerPoints = chamferSplitPerimeter(
        [tail[0]!.start, ...tail.map((s) => s.end)],
        params.traceWidth,
      )
      const singleton = buildViaMinimalWindingPlan({
        ...params,
        terminal: { ...terminal, viaPoint: updated.via.center },
        sourceEscapePoints: [
          updated.segments[0]!.start,
          ...updated.segments.map((s) => s.end),
        ],
        targetLayerPoints,
        allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
      })
      const plans = result.plans.map((p) =>
        p.connectionIndex === connection.connectionIndex ? singleton : p,
      )
      if (
        !fanoutPlansAreClear({
          ...params,
          plans,
          sharedBoundary: bus.sharedBoundary,
        }) ||
        !plansPreserveSourcesAndCorners({
          ...params,
          plans,
          sourceEscapes: result.sourceEscapes,
        })
      )
        continue
      return { ...result, plans }
    }
  }
  return null
}
