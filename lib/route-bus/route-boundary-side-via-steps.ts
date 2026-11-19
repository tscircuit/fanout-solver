import { getDirectionForExitEdge } from "../boundary-exit"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
} from "../geometry"
import { getViaSpanLayers } from "../layer-names"
import { connectionsShareElectricalNet } from "../net-identity"
import { routeViaMinimalWindingAlternativesSteps } from "../route-via-minimal-winding"
import type { FanoutRoutePlan, RoutedSegment } from "../types"
import { addAlternative } from "./boundary-routing-context"
import { getBoundaryTargetTrack, getCornerTargetTrack } from "./boundary-tracks"
import { getCornerSide, getExitAxis, makePoint } from "./directions"
import { getBoundaryViaCandidates } from "./get-boundary-via-candidates"
import { fanoutPlansAreClear } from "./plan-clearance"
import type {
  RouteBusAlternativesProgress,
  RouteBusBoundaryContext,
} from "./types"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

export function* routeBoundarySideViaSteps(
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
    allowBoundarySideViaFallback,
    preferCornerBoundaryVia,
    cornerBandTargetTrackOffset,
    forbidEarlyExitBoundaryContact,
    cornerLaneOffsets,
    alternatives,
    includeVisualization,
  } = context
  // A through-via does not have to sit next to the source pad. A narrow bus
  // embedded in another bus's source field can have every local dogbone site
  // occupied while still having a clear source-layer escape. A pair first
  // relocates its two vias just outside the nearest package edge. A singleton
  // tries the existing boundary-side vias before searching outside the package.
  // Both forms preserve one via per signal without weakening clearance rules.
  if (
    alternatives.length === 0 &&
    allowBoundarySideViaFallback &&
    fixedViaPointsByConnectionIndex &&
    bus.connections.length <= 2 &&
    bus.exitEdge &&
    bus.connections.every(
      (connection) =>
        connection.sourceLayer === bus.connections[0]!.sourceLayer &&
        connection.sourceLayer !== targetLayer,
    )
  ) {
    const sourceLayer = bus.connections[0]!.sourceLayer
    const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
    const boundaryExitAxis = getExitAxis(bus, boundaryDirection)
    const finalTracks = bus.connections.map((preparedConnection) =>
      preferCornerBoundaryVia && getCornerSide(bus)
        ? getCornerTargetTrack({
            fixedBoundaryTracksByConnectionIndex,
            bus,
            connection: preparedConnection,
            cornerExitLaneOffset: cornerLaneOffsets.exit,
            traceWidth,
            viaDiameter,
            clearance,
            layerNames,
            targetLayer,
            cornerBandTargetTrackOffset,
          })
        : getBoundaryTargetTrack({
            fixedBoundaryTracksByConnectionIndex,
            bus,
            connection: preparedConnection,
            boundaryDirection,
            traceWidth,
            clearance,
            layerNames,
            targetLayer,
          }),
    )
    const finalExitPoints = finalTracks.map((track) =>
      makePoint({
        axis: boundaryExitAxis,
        perpendicularAxis: track,
        direction: boundaryDirection,
      }),
    )
    const sourceLayerSrj: SimpleRouteJson = {
      ...srj,
      obstacles: srj.obstacles.map((obstacle) => {
        const connection = bus.connections.find(
          (connection) =>
            obstacle === connection.sourceObstacle ||
            (distance(obstacle.center, connection.sourcePoint) <= 1e-7 &&
              obstacle.layers.includes(connection.sourceLayer)),
        )
        return connection
          ? {
              ...obstacle,
              connectedTo: [
                ...obstacle.connectedTo,
                connection.connection.name,
              ],
            }
          : obstacle
      }),
    }
    const viaCandidates = getBoundaryViaCandidates(
      { finalTracks, boundaryDirection, boundaryExitAxis },
      context,
    )
    for (const { points: boundaryViaPoints, boundarySide } of viaCandidates) {
      const boundaryVias = bus.connections.map((connection, index) => ({
        connectionName: connection.connection.name,
        via: {
          center: boundaryViaPoints[index]!,
          diameter: viaDiameter,
          spanLayers: getViaSpanLayers({
            fromLayer: sourceLayer,
            toLayer: targetLayer,
            layerNames,
            allowBlindAndBuriedVias,
          }),
        },
      }))
      if (
        boundaryVias.some((candidate, index) =>
          boundaryVias.some(
            (other, otherIndex) =>
              index !== otherIndex &&
              (distance(candidate.via.center, other.via.center) <
                viaDiameter + clearance - 1e-9 ||
                (boundarySide &&
                  distancePointToSegment(
                    candidate.via.center,
                    other.via.center,
                    finalExitPoints[otherIndex]!,
                  ) <
                    viaDiameter / 2 + traceWidth / 2 + clearance - 1e-9)),
          ),
        )
      )
        continue
      if (
        boundaryVias.some(({ via }) =>
          srj.obstacles.some(
            (obstacle) =>
              obstacle.layers.some((layer) => via.spanLayers.includes(layer)) &&
              distancePointToObstacle(via.center, obstacle) <
                via.diameter / 2 + clearance - 1e-9,
          ),
        )
      )
        continue
      const sourceLayerSteps = routeViaMinimalWindingAlternativesSteps(
        {
          heuristicWeight: context.windingHeuristicWeight,
          srj: sourceLayerSrj,
          bus,
          targetLayer: sourceLayer,
          terminals: bus.connections.map((preparedConnection, index) => ({
            connection: preparedConnection,
            viaPoint: preparedConnection.sourcePoint,
            exitPoint: boundaryViaPoints[index]!,
          })),
          acceptedPlans,
          layerNames,
          traceWidth,
          viaDiameter,
          viaHoleDiameter,
          clearance,
          allowBlindAndBuriedVias,
          allowSameNetMerges,
          maximumRouteOrderAttempts: bus.connections.length === 1 ? 3 : 6,
          softReservedVias,
          reservedVias:
            bus.connections.length > 1
              ? [...reservedVias, ...boundaryVias]
              : reservedVias,
          gridStepDivisor: 2,
          allowSourceLayerRouting: true,
          alignGridToPads: true,
          forbidEarlyExitBoundaryContact,
        },
        1,
        includeVisualization,
      )
      let sourceLayerResult = sourceLayerSteps.next()
      while (!sourceLayerResult.done) {
        yield {
          phase: "via-minimal-winding",
          busId: bus.busId,
          targetLayer: sourceLayer,
          winding: sourceLayerResult.value,
        }
        sourceLayerResult = sourceLayerSteps.next()
      }
      const sourceLayerPlans = sourceLayerResult.value[0]
      if (
        !sourceLayerPlans ||
        sourceLayerPlans.length !== bus.connections.length
      )
        continue
      let targetLayerPlans: FanoutRoutePlan[] | undefined
      if (!boundarySide) {
        const targetSteps = routeViaMinimalWindingAlternativesSteps(
          {
            heuristicWeight: context.windingHeuristicWeight,
            srj,
            bus,
            targetLayer,
            terminals: bus.connections.map((connection, index) => ({
              connection,
              viaPoint: boundaryViaPoints[index]!,
              exitPoint: finalExitPoints[index]!,
            })),
            acceptedPlans,
            layerNames,
            traceWidth,
            viaDiameter,
            viaHoleDiameter,
            clearance,
            allowBlindAndBuriedVias,
            allowSameNetMerges,
            maximumRouteOrderAttempts: 6,
            reservedVias,
            softReservedVias,
            gridStepDivisor: 2,
            alignGridToPads: true,
            forbidEarlyExitBoundaryContact,
          },
          1,
          includeVisualization,
        )
        let targetResult = targetSteps.next()
        while (!targetResult.done) {
          yield {
            phase: "via-minimal-winding",
            busId: bus.busId,
            targetLayer,
            winding: targetResult.value,
          }
          targetResult = targetSteps.next()
        }
        targetLayerPlans = targetResult.value[0]
        if (!targetLayerPlans) continue
      }
      const plans: FanoutRoutePlan[] = sourceLayerPlans.map(
        (sourceLayerPlan, index) => {
          const boundaryViaPoint = boundaryViaPoints[index]!
          const finalExitPoint = finalExitPoints[index]!
          const targetSegment: RoutedSegment = {
            start: boundaryViaPoint,
            end: finalExitPoint,
            width: traceWidth,
            layer: targetLayer,
          }
          const targetSegments = targetLayerPlans
            ? targetLayerPlans[index]!.segments.filter(
                (segment) => segment.layer === targetLayer,
              )
            : [targetSegment]
          const via = {
            center: boundaryViaPoint,
            diameter: viaDiameter,
            holeDiameter: viaHoleDiameter,
            fromLayer: sourceLayer,
            toLayer: targetLayer,
            spanLayers: getViaSpanLayers({
              fromLayer: sourceLayer,
              toLayer: targetLayer,
              layerNames,
              allowBlindAndBuriedVias,
            }),
          }
          const sourceRoute = sourceLayerPlan.trace.route.filter(
            (item) => item.route_type === "wire",
          )
          return {
            ...sourceLayerPlan,
            ...(preferCornerBoundaryVia ||
            bus.connections.length > 1 ||
            !boundarySide
              ? { sourceEscapeSegmentCount: sourceLayerPlan.segments.length }
              : {}),
            targetLayer,
            exitPoint: finalExitPoint,
            via,
            segments: [...sourceLayerPlan.segments, ...targetSegments],
            length:
              sourceLayerPlan.length +
              targetSegments.reduce(
                (sum, segment) => sum + distance(segment.start, segment.end),
                0,
              ),
            trace: {
              ...sourceLayerPlan.trace,
              route: [
                ...sourceRoute,
                {
                  route_type: "via",
                  ...boundaryViaPoint,
                  from_layer: sourceLayer,
                  to_layer: targetLayer,
                  via_diameter: viaDiameter,
                  via_hole_diameter: viaHoleDiameter,
                },
                {
                  route_type: "wire",
                  ...boundaryViaPoint,
                  width: traceWidth,
                  layer: targetLayer,
                },
                ...targetSegments.map((segment) => ({
                  route_type: "wire" as const,
                  ...segment.end,
                  width: traceWidth,
                  layer: targetLayer,
                })),
              ],
            },
          }
        },
      )
      const boundaryViaPlansAreClear = fanoutPlansAreClear({
        plans: [...acceptedPlans, ...plans],
        srj,
        sharedBoundary: bus.sharedBoundary,
        clearance,
        allowBlindAndBuriedVias,
        allowSameNetMerges,
      })
      const reservedViasAreClear = plans.every((plan) =>
        reservedVias.every((reserved) => {
          const via = plan.via!
          if (
            reserved.connectionName === plan.connectionName ||
            (allowSameNetMerges &&
              connectionsShareElectricalNet(
                srj,
                reserved.connectionName,
                plan.connectionName,
              ))
          )
            return true
          if (
            via.spanLayers.some((layer) =>
              reserved.via.spanLayers.includes(layer),
            ) &&
            distance(via.center, reserved.via.center) <
              (via.diameter + reserved.via.diameter) / 2 + clearance - 1e-9
          )
            return false
          return plan.segments.every(
            (segment) =>
              !reserved.via.spanLayers.includes(segment.layer) ||
              distancePointToSegment(
                reserved.via.center,
                segment.start,
                segment.end,
              ) >=
                reserved.via.diameter / 2 + traceWidth / 2 + clearance - 1e-9,
          )
        }),
      )
      if (boundaryViaPlansAreClear && reservedViasAreClear) {
        addAlternative(plans, context)
        return true
      }
    }
  }

  return false
}
