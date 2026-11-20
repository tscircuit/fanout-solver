import type { FanoutRoutePlan } from "../types"
import { createBoundaryRoutingContext } from "./boundary-routing-context"
import { routeAnalyticBoundaryAlternatives } from "./route-analytic-boundary-alternatives"
import { routeBoundarySideViaSteps } from "./route-boundary-side-via-steps"
import { routeCoordinatedBoundarySteps } from "./route-coordinated-boundary-steps"
import { routePlaneTerminatedBus } from "./route-plane-terminated-bus"
import { routeSingletonBoundarySteps } from "./route-singleton-boundary-steps"
import type { RouteBusAlternativesProgress, RouteBusParams } from "./types"

export function* routeBusAlternativesSteps(
  params: RouteBusParams,
  maxAlternatives = 1,
  includeVisualization = false,
): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[][], void> {
  const traceWidth = params.bus.traceWidth ?? params.traceWidth
  if (traceWidth !== params.traceWidth) params = { ...params, traceWidth }
  const {
    bus,
    fixedViaPointsByConnectionIndex,
    fixedBoundaryTracksByConnectionIndex,
    cornerExitLaneOffset,
  } = params
  if (!Number.isInteger(maxAlternatives) || maxAlternatives < 1) {
    throw new Error(
      `FanoutSolver: maxAlternatives must be a positive integer, received ${maxAlternatives}`,
    )
  }
  if (
    cornerExitLaneOffset !== undefined &&
    (!Number.isSafeInteger(cornerExitLaneOffset) || cornerExitLaneOffset < 0)
  ) {
    throw new Error(
      `FanoutSolver: cornerExitLaneOffset must be a non-negative safe integer, received ${cornerExitLaneOffset}`,
    )
  }
  if (
    fixedViaPointsByConnectionIndex &&
    bus.connections.some(
      (connection) =>
        !fixedViaPointsByConnectionIndex.has(connection.connectionIndex),
    )
  ) {
    return []
  }
  if (bus.termination.type === "plane") {
    const alternatives: FanoutRoutePlan[][] = []
    if (bus.connections.length === 1 && maxAlternatives > 1) {
      // Enumerate once instead of rebuilding and skipping every earlier route
      // for each successive alternative. Keep the original candidate order.
      routePlaneTerminatedBus({
        ...params,
        planeCandidateSkipCount: 0,
        collectAlternative: (plan) => {
          alternatives.push([plan])
          return alternatives.length >= maxAlternatives
        },
      })
      return alternatives
    }
    for (
      let planeCandidateSkipCount = 0;
      planeCandidateSkipCount < maxAlternatives;
      planeCandidateSkipCount++
    ) {
      const plan = routePlaneTerminatedBus({
        ...params,
        planeCandidateSkipCount,
      })
      if (!plan) break
      alternatives.push(plan)
    }
    return alternatives
  }
  if (fixedBoundaryTracksByConnectionIndex) {
    if (!bus.exitEdge)
      throw new Error(
        "FanoutSolver: fixed boundary tracks require an exit edge",
      )
    const vertical = bus.exitEdge === "left" || bus.exitEdge === "right"
    const minimum = vertical ? bus.sharedBoundary.minY : bus.sharedBoundary.minX
    const maximum = vertical ? bus.sharedBoundary.maxY : bus.sharedBoundary.maxX
    for (const connection of bus.connections) {
      const track = fixedBoundaryTracksByConnectionIndex.get(
        connection.connectionIndex,
      )
      if (
        track === undefined ||
        !Number.isFinite(track) ||
        track < minimum - 1e-9 ||
        track > maximum + 1e-9
      )
        throw new Error(
          `FanoutSolver: invalid fixed boundary track for ${connection.connection.name}`,
        )
    }
  }
  if (!bus.connections[0]?.sourceObstacle) return [[]]
  const context = createBoundaryRoutingContext(
    { maxAlternatives, includeVisualization },
    params,
  )
  if (yield* routeSingletonBoundarySteps(context)) return context.alternatives
  if (yield* routeCoordinatedBoundarySteps(context)) return context.alternatives
  if (yield* routeBoundarySideViaSteps(context)) return context.alternatives
  routeAnalyticBoundaryAlternatives(context)
  return context.alternatives
}
