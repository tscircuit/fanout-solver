import type { FanoutRoutePlan } from "../types"
import { getCornerLaneOffsets } from "./boundary-tracks"
import { busIsOnOutwardComponentEdge } from "./connection-order"
import {
  getDirectionalPitch,
  getExitAxis,
  getPerpendicularAxis,
  isHorizontal,
} from "./directions"
import type {
  RouteBusBoundaryContext,
  RouteBusParams,
  ViaHandedness,
} from "./types"

export function createBoundaryRoutingContext(
  {
    maxAlternatives,
    includeVisualization,
  }: { maxAlternatives: number; includeVisualization: boolean },
  params: RouteBusParams,
): RouteBusBoundaryContext {
  const {
    bus,
    targetLayer,
    acceptedPlans,
    viaDiameter,
    clearance,
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
    stopAfterFirstRejectedViaMinimalCandidate = false,
    reservedVias = [],
    softReservedVias = [],
    viaMinimalOnly = false,
    allowBoundarySideViaFallback = false,
    preferCornerBoundaryVia = false,
    adaptiveWindingRouteOrder = false,
    alignWindingGridToPads = false,
    fixedViaFallbackRouteOrderAttempts = 24,
    allowFixedViaReservedExitFallback = false,
    cornerExitLaneOffset,
    forbidEarlyExitBoundaryContact = false,
  } = params
  const exitAxis = getExitAxis(bus)
  const sourceObstacle = bus.connections[0]?.sourceObstacle
  if (!sourceObstacle)
    throw new Error("FanoutSolver: boundary routing requires a source obstacle")
  const directionalPadSize = isHorizontal(bus.direction)
    ? sourceObstacle.width
    : sourceObstacle.height
  const sourceLayer = bus.connections[0]!.sourceLayer
  const targetUsesVia = targetLayer !== sourceLayer
  const outwardEdgeBus = busIsOnOutwardComponentEdge(bus)
  const pairChannelFitsVia =
    getDirectionalPitch(bus) / 2 - directionalPadSize / 2 >=
    viaDiameter / 2 + clearance - 1e-9
  const interstitialEscape =
    targetUsesVia && !outwardEdgeBus && !pairChannelFitsVia
  const availableViaHandednesses: readonly ViaHandedness[] = targetUsesVia
    ? pairChannelFitsVia || outwardEdgeBus
      ? [0]
      : allowBlindAndBuriedVias
        ? [1, -1]
        : [-1, 1]
    : [0]
  const viaHandednesses: readonly ViaHandedness[] = (() => {
    if (allowBlindAndBuriedVias) return availableViaHandednesses
    if (
      availableViaHandednesses.length !== 2 ||
      !availableViaHandednesses.includes(-1) ||
      !availableViaHandednesses.includes(1)
    ) {
      return availableViaHandednesses
    }

    // Prefer placing the dogbone via away from the boundary targets. This
    // leaves the open routing chamber between the source field and the final
    // exit band, which is especially important when physical barrels span
    // every copper layer. The opposite hand remains an immediate fallback.
    const meanSourceTrack =
      bus.connections.reduce(
        (sum, connection) =>
          sum + getPerpendicularAxis(connection.sourcePoint, bus.direction),
        0,
      ) / bus.connections.length
    const meanTargetTrack =
      bus.connections.reduce(
        (sum, connection) =>
          sum +
          getPerpendicularAxis(
            connection.exitTargetPoint ?? connection.targetPoint,
            bus.direction,
          ),
        0,
      ) / bus.connections.length
    if (meanTargetTrack > meanSourceTrack + 1e-9) return [-1, 1]
    if (meanTargetTrack < meanSourceTrack - 1e-9) return [1, -1]
    return availableViaHandednesses
  })()

  const alternatives: FanoutRoutePlan[][] = []
  const seenAlternativeKeys = new Set<string>()
  const cornerLaneOffsets = getCornerLaneOffsets(bus, acceptedPlans)
  if (cornerExitLaneOffset !== undefined) {
    cornerLaneOffsets.exit = cornerExitLaneOffset
  }

  return {
    ...params,
    allowBlindAndBuriedVias,
    allowSameNetMerges,
    stopAfterFirstRejectedViaMinimalCandidate,
    reservedVias,
    softReservedVias,
    viaMinimalOnly,
    allowBoundarySideViaFallback,
    preferCornerBoundaryVia,
    adaptiveWindingRouteOrder,
    alignWindingGridToPads,
    fixedViaFallbackRouteOrderAttempts,
    allowFixedViaReservedExitFallback,
    forbidEarlyExitBoundaryContact,
    exitAxis,
    targetUsesVia,
    interstitialEscape,
    viaHandednesses,
    cornerLaneOffsets,
    alternatives,
    seenAlternativeKeys,
    maxAlternatives,
    includeVisualization,
  }
}

export function addAlternative(
  plans: FanoutRoutePlan[],
  context: RouteBusBoundaryContext,
): void {
  const {
    fixedBoundaryTracksByConnectionIndex,
    bus,
    seenAlternativeKeys,
    alternatives,
  } = context
  if (
    fixedBoundaryTracksByConnectionIndex &&
    plans.some((plan) => {
      const track = fixedBoundaryTracksByConnectionIndex.get(
        plan.connectionIndex,
      )!
      const actual =
        bus.exitEdge === "left" || bus.exitEdge === "right"
          ? plan.exitPoint.y
          : plan.exitPoint.x
      return Math.abs(actual - track) > 1e-9
    })
  )
    return
  const key = plans
    .map(
      (plan) =>
        `${plan.connectionIndex}:${plan.targetLayer}:${plan.exitPoint.x}:${plan.exitPoint.y}:${plan.segments.map((segment) => `${segment.start.x},${segment.start.y},${segment.end.x},${segment.end.y},${segment.layer}`).join(";")}`,
    )
    .join("|")
  if (seenAlternativeKeys.has(key)) return
  seenAlternativeKeys.add(key)
  alternatives.push(plans)
}
