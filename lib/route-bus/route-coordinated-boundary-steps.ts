import { getDirectionForExitEdge } from "../boundary-exit"
import { matchComponentDogboneViaSites } from "../match-component-dogbone-via-sites"
import { routeViaMinimalWindingAlternativesSteps } from "../route-via-minimal-winding"
import { addAlternative } from "./boundary-routing-context"
import { getBoundaryTargetTrack, getCornerTargetTrack } from "./boundary-tracks"
import {
  busUsesCoordinatedWindingChannel,
  getCornerSide,
  getExitAxis,
  makePoint,
} from "./directions"
import { getCoordinatedTerminalPatterns } from "./get-coordinated-terminal-patterns"
import { fanoutPlansAreClear } from "./plan-clearance"
import { getPlanSegments, getPlanVias } from "./plan-copper"
import { getInitialViaPoint } from "./source-escape"
import type {
  RouteBusAlternativesProgress,
  RouteBusBoundaryContext,
} from "./types"

export function* routeCoordinatedBoundarySteps(
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
    rejectedViaMinimalCandidates,
    stopAfterFirstRejectedViaMinimalCandidate,
    fixedViaPointsByConnectionIndex,
    fixedBoundaryTracksByConnectionIndex,
    reservedVias,
    softReservedVias,
    viaMinimalOnly,
    adaptiveWindingRouteOrder,
    alignWindingGridToPads,
    cornerBandTargetTrackOffset,
    forbidEarlyExitBoundaryContact,
    cornerLaneOffsets,
    alternatives,
    maxAlternatives,
    includeVisualization,
  } = context
  if (busUsesCoordinatedWindingChannel(bus) && bus.exitEdge) {
    const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
    const boundaryExitAxis = getExitAxis(bus, boundaryDirection)
    const cornerSide = getCornerSide(bus)
    const terminalPatterns = getCoordinatedTerminalPatterns(context)
    const seenTerminalSignatures = new Set<string>()
    for (const terminalPattern of terminalPatterns) {
      const terminals = bus.connections.map((preparedConnection) => {
        const viaHandedness =
          terminalPattern.getViaHandedness(preparedConnection)
        const boundaryTrack = cornerSide
          ? getCornerTargetTrack({
              fixedBoundaryTracksByConnectionIndex,
              bus,
              connection: preparedConnection,
              cornerExitLaneOffset:
                terminalPattern.cornerExitLaneOffset ?? cornerLaneOffsets.exit,
              traceWidth,
              viaDiameter,
              clearance,
              layerNames,
              targetLayer,
              windingOrderIndex: terminalPattern.windingOrderIndex,
              cornerBandTargetTrackOffset,
            })
          : getBoundaryTargetTrack({
              fixedBoundaryTracksByConnectionIndex,
              allowLayerInterleaving: terminalPattern.allowLayerInterleaving,
              bus,
              connection: preparedConnection,
              boundaryDirection,
              traceWidth,
              clearance,
              layerNames,
              targetLayer,
              windingOrderIndex: terminalPattern.windingOrderIndex,
            })
        return {
          connection: preparedConnection,
          viaPoint: terminalPattern.getViaPoint
            ? terminalPattern.getViaPoint(preparedConnection)
            : terminalPattern.useViaInPad
              ? {
                  x: preparedConnection.sourcePoint.x,
                  y: preparedConnection.sourcePoint.y,
                }
              : getInitialViaPoint({
                  preparedConnection,
                  bus,
                  targetLayer,
                  traceWidth,
                  viaDiameter,
                  clearance,
                  viaHandedness,
                }),
          exitPoint: makePoint({
            axis: boundaryExitAxis,
            perpendicularAxis: boundaryTrack,
            direction: boundaryDirection,
          }),
        }
      })
      const alignGridToPads =
        alignWindingGridToPads ||
        Boolean(terminalPattern.getViaPoint && !fixedViaPointsByConnectionIndex)
      if (
        terminalPattern.localDogboneRepair &&
        !matchComponentDogboneViaSites([bus], {
          viaDiameter,
          viaHoleDiameter,
          traceWidth,
          clearance,
          additionalObstacles: srj.obstacles,
          fixedViaPointsByConnectionIndex: new Map(
            terminals.map((terminal) => [
              terminal.connection.connectionIndex,
              terminal.viaPoint,
            ]),
          ),
          blockingSegments: acceptedPlans.flatMap((plan) =>
            getPlanSegments(plan).map((segment) => ({
              connectionIndex: plan.connectionIndex,
              segment,
            })),
          ),
          blockingVias: [
            ...acceptedPlans.flatMap((plan) =>
              getPlanVias(plan).map((via) => ({
                connectionIndex: plan.connectionIndex,
                center: via.center,
                diameter: via.diameter,
                spanLayers: via.spanLayers,
              })),
            ),
            // These are future connections, not members of the current bus.
            ...reservedVias.map(({ via }) => ({ connectionIndex: -1, ...via })),
          ],
        })
      ) {
        continue
      }
      const gridStepDivisor =
        terminalPattern.getViaPoint &&
        Math.min(bus.pitchX, bus.pitchY) -
          2 * (viaDiameter / 2 + traceWidth / 2 + clearance) <
          traceWidth + clearance
          ? 2
          : 1
      const terminalSignature = `${terminals
        .map(
          (terminal) =>
            `${terminal.connection.connectionIndex}:${terminal.viaPoint.x}:${terminal.viaPoint.y}:${terminal.exitPoint.x}:${terminal.exitPoint.y}`,
        )
        .join(
          "|",
        )}:${terminalPattern.maximumRouteOrderAttempts ?? "all"}:${gridStepDivisor}:${alignGridToPads}:${Boolean(terminalPattern.localDogboneRepair)}:${Boolean(terminalPattern.preferTargetDirectedLaneBias)}:${Boolean(terminalPattern.reserveTerminalExitPoints)}`
      if (seenTerminalSignatures.has(terminalSignature)) continue
      seenTerminalSignatures.add(terminalSignature)
      const windingSteps = routeViaMinimalWindingAlternativesSteps(
        {
          heuristicWeight: context.windingHeuristicWeight,
          srj,
          bus,
          targetLayer,
          terminals,
          acceptedPlans,
          layerNames,
          traceWidth,
          viaDiameter,
          viaHoleDiameter,
          clearance,
          allowBlindAndBuriedVias,
          allowSameNetMerges,
          maximumRouteOrderAttempts: terminalPattern.maximumRouteOrderAttempts,
          adaptiveRouteOrder: adaptiveWindingRouteOrder,
          alignGridToPads,
          includeReverseTargetRotation: terminalPattern.localDogboneRepair,
          reservedVias,
          softReservedVias,
          reserveTerminalExitPoints: terminalPattern.reserveTerminalExitPoints,
          gridStepDivisor,
          gridStep: context.windingGridStep,
          sourceEscapePaths: context.sourceEscapePaths,
          preferTargetDirectedLaneBias:
            terminalPattern.preferTargetDirectedLaneBias,
          forbidEarlyExitBoundaryContact,
        },
        fixedViaPointsByConnectionIndex && viaMinimalOnly
          ? Math.min(2, Math.max(1, maxAlternatives - alternatives.length))
          : terminalPattern.maximumRouteOrderAttempts === undefined
            ? Math.min(2, maxAlternatives - alternatives.length)
            : 2,
        includeVisualization,
      )
      let windingResult = windingSteps.next()
      while (!windingResult.done) {
        yield {
          phase: "via-minimal-winding",
          busId: bus.busId,
          targetLayer,
          winding: windingResult.value,
        }
        windingResult = windingSteps.next()
      }
      const viaMinimalAlternatives = windingResult.value
      for (const viaMinimalPlans of viaMinimalAlternatives) {
        const combinedPlansAreClear = fanoutPlansAreClear({
          plans: [...acceptedPlans, ...viaMinimalPlans],
          srj,
          sharedBoundary: bus.sharedBoundary,
          clearance,
          allowBlindAndBuriedVias,
          allowSameNetMerges,
        })
        if (!combinedPlansAreClear) {
          const candidateIsInternallyClear = fanoutPlansAreClear({
            plans: viaMinimalPlans,
            srj,
            sharedBoundary: bus.sharedBoundary,
            clearance,
            allowBlindAndBuriedVias,
            allowSameNetMerges,
          })
          if (candidateIsInternallyClear && rejectedViaMinimalCandidates) {
            rejectedViaMinimalCandidates.push(viaMinimalPlans)
            if (stopAfterFirstRejectedViaMinimalCandidate) {
              return true
            }
          }
          continue
        }
        addAlternative(viaMinimalPlans, context)
        if (alternatives.length >= maxAlternatives) return true
      }
    }
  }

  return false
}
