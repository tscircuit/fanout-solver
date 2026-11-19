import type { FanoutRoutePlan } from "../types"
import { createBoundaryRoutingContext } from "./boundary-routing-context"
import { routeAnalyticBoundaryAlternatives } from "./route-analytic-boundary-alternatives"
import { routeBoundarySideViaSteps } from "./route-boundary-side-via-steps"
import { routeCoordinatedBoundarySteps } from "./route-coordinated-boundary-steps"
import { routePlaneTerminatedBus } from "./route-plane-terminated-bus"
import { routeSingletonBoundarySteps } from "./route-singleton-boundary-steps"
import type { RouteBusAlternativesProgress, RouteBusParams } from "./types"

type PlaneAlternativeKey = string

function getPlaneTierAlternatives(
  {
    candidateTier,
    maxAlternatives,
  }: { candidateTier: "ordinary" | "expanded"; maxAlternatives: number },
  params: RouteBusParams,
): FanoutRoutePlan[][] {
  const alternatives: FanoutRoutePlan[][] = []
  const seen = new Set<PlaneAlternativeKey>()
  routePlaneTerminatedBus({
    ...params,
    candidateTier,
    planeCandidateSkipCount: 0,
    collectAlternative: (plan) => {
      const key = JSON.stringify([
        plan.trace.route,
        plan.planeEndpointTrace?.route,
      ])
      if (seen.has(key)) return false
      seen.add(key)
      alternatives.push([plan])
      return alternatives.length >= maxAlternatives
    },
  })
  return alternatives
}

export function* routeBusAlternativesSteps(
  params: RouteBusParams,
  maxAlternatives = 1,
  includeVisualization = false,
): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[][], void> {
  params = {
    ...params,
    traceWidth: params.bus.traceWidth ?? params.traceWidth,
  }
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
      const ordinary = getPlaneTierAlternatives(
        { candidateTier: "ordinary", maxAlternatives },
        params,
      )
      const expanded = getPlaneTierAlternatives(
        { candidateTier: "expanded", maxAlternatives },
        params,
      )
      // Keep the legacy winner first and give both search domains room.
      const seen = new Set<PlaneAlternativeKey>()
      for (let index = 0; alternatives.length < maxAlternatives; index++) {
        if (!ordinary[index] && !expanded[index]) break
        for (const candidate of [ordinary[index], expanded[index]]) {
          if (!candidate) continue
          const key = JSON.stringify(
            candidate.map((plan) => [
              plan.trace.route,
              plan.planeEndpointTrace?.route,
            ]),
          )
          if (seen.has(key)) continue
          seen.add(key)
          alternatives.push(candidate)
          if (alternatives.length >= maxAlternatives) break
        }
      }
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
