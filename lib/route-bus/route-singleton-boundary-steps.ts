import { getDirectionForExitEdge } from "../boundary-exit"
import { routeViaMinimalWindingAlternativesSteps } from "../route-via-minimal-winding"
import { addAlternative } from "./boundary-routing-context"
import { getBoundaryTargetTrack } from "./boundary-tracks"
import {
  busUsesCoordinatedWindingChannel,
  getExitAxis,
  makePoint,
} from "./directions"
import { fanoutPlansAreClear } from "./plan-clearance"
import type {
  RouteBusAlternativesProgress,
  RouteBusBoundaryContext,
} from "./types"

export function* routeSingletonBoundarySteps(
  context: RouteBusBoundaryContext,
): Generator<RouteBusAlternativesProgress, boolean, void> {
  const {
    srj,
    bus,
    targetLayer,
    acceptedPlans,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    allowBlindAndBuriedVias,
    allowSameNetMerges,
    fixedViaPointsByConnectionIndex,
    fixedBoundaryTracksByConnectionIndex,
    reservedVias,
    softReservedVias,
    alignWindingGridToPads,
    forbidEarlyExitBoundaryContact,
    alternatives,
    maxAlternatives,
    includeVisualization,
  } = context
  // A fixed source escape is also useful for an ordinary singleton whose
  // boundary endpoint came directly from the SRJ, rather than layered guidance.
  // Keep that endpoint and the original metadata; no winding order is needed.
  if (
    !busUsesCoordinatedWindingChannel(bus) &&
    bus.exitEdge &&
    bus.connections.length === 1 &&
    layerNames.includes(targetLayer) &&
    (bus.allowedLayers === undefined ||
      bus.allowedLayers.includes(targetLayer)) &&
    (bus.routableEscapeLayers === undefined ||
      bus.routableEscapeLayers.includes(targetLayer)) &&
    bus.connections[0]!.sourceLayer !== targetLayer &&
    fixedViaPointsByConnectionIndex &&
    context.sourceEscapePaths?.has(bus.connections[0]!.connectionIndex)
  ) {
    const connection = bus.connections[0]!
    const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
    const singletonSteps = routeViaMinimalWindingAlternativesSteps(
      {
        srj,
        bus,
        targetLayer,
        terminals: [
          {
            connection,
            viaPoint: fixedViaPointsByConnectionIndex.get(
              connection.connectionIndex,
            )!,
            exitPoint: makePoint({
              axis: getExitAxis(bus, boundaryDirection),
              perpendicularAxis: getBoundaryTargetTrack({
                fixedBoundaryTracksByConnectionIndex,
                bus,
                connection,
                boundaryDirection,
              }),
              direction: boundaryDirection,
            }),
          },
        ],
        acceptedPlans,
        layerNames,
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
        clearance,
        allowBlindAndBuriedVias,
        allowSameNetMerges,
        maximumRouteOrderAttempts: 3,
        reservedVias,
        softReservedVias,
        gridStepDivisor: 2,
        gridStep: context.windingGridStep,
        alignGridToPads: alignWindingGridToPads,
        sourceEscapePaths: context.sourceEscapePaths,
        heuristicWeight: context.windingHeuristicWeight,
        forbidEarlyExitBoundaryContact,
      },
      maxAlternatives,
      includeVisualization,
    )
    let singletonResult = singletonSteps.next()
    while (!singletonResult.done) {
      yield {
        phase: "via-minimal-winding",
        busId: bus.busId,
        targetLayer,
        winding: singletonResult.value,
      }
      singletonResult = singletonSteps.next()
    }
    for (const singletonPlans of singletonResult.value) {
      if (
        !fanoutPlansAreClear({
          plans: [...acceptedPlans, ...singletonPlans],
          srj,
          sharedBoundary: bus.sharedBoundary,
          clearance,
          allowBlindAndBuriedVias,
          allowSameNetMerges,
        })
      )
        continue
      addAlternative(singletonPlans, context)
      if (alternatives.length >= maxAlternatives) return true
    }
  }

  return false
}
