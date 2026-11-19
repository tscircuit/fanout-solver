import { getDirectionForExitEdge } from "../boundary-exit"
import type { FanoutRoutePlan, Point2D, RoutedSegment } from "../types"
import { appendLayerPath, appendTransitionVia } from "./append-plan-route"
import { getBoundaryTargetTrack, getCornerTargetTrack } from "./boundary-tracks"
import { getConnectionRank } from "./connection-order"
import {
  busUsesCoordinatedWindingChannel,
  directionSign,
  getAxis,
  getCornerSide,
  getDirectionalPitch,
  getExitAxis,
  getLocalCornerSide,
  getPerpendicularAxis,
  isHorizontal,
  makePoint,
} from "./directions"
import { chamferOrthogonalPolyline } from "./source-escape"
import type { BuildPlanParams } from "./types"
import { getWindingCrossoverLayer } from "./winding-target-orders"
import type { SimplifiedPcbTrace } from "@tscircuit/capacity-autorouter"

export function appendPlanBoundary(
  {
    viaPoint,
    segments,
    route,
  }: {
    viaPoint: Point2D
    segments: RoutedSegment[]
    route: SimplifiedPcbTrace["route"]
  },
  params: BuildPlanParams,
): {
  exitPoint: Point2D
  additionalVias: NonNullable<FanoutRoutePlan["additionalVias"]>
} {
  const {
    preparedConnection,
    bus,
    targetLayer,
    track: requestedTrack,
    exitAxis,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    interstitialEscape,
    spreadLaneIndex,
    cornerExitLaneOffset,
    cornerLocalChannelLaneOffset,
    cornerBoundaryChannelLaneOffset,
    clearance,
    terminateAtVia,
    allowBlindAndBuriedVias,
    cornerBandTargetTrackOffset,
    fixedBoundaryTracksByConnectionIndex,
  } = params
  const cornerSide = getCornerSide(bus)
  const escapeLayer = targetLayer
  const windingCrossoverLayer = busUsesCoordinatedWindingChannel(bus)
    ? getWindingCrossoverLayer({ bus, escapeLayer })
    : undefined
  const usesLayeredWindingChannel = Boolean(windingCrossoverLayer)
  const fixedBoundaryTrack = fixedBoundaryTracksByConnectionIndex?.get(
    preparedConnection.connectionIndex,
  )
  const boundaryDirection = bus.exitEdge
    ? getDirectionForExitEdge(bus.exitEdge)
    : bus.direction
  const track =
    fixedBoundaryTrack !== undefined &&
    !cornerSide &&
    bus.direction === boundaryDirection
      ? fixedBoundaryTrack
      : requestedTrack
  const sign = directionSign(bus.direction)
  const directionalPitch = getDirectionalPitch(bus)
  const viaAxis = getAxis(viaPoint, bus.direction)
  const viaPerpendicularAxis = getPerpendicularAxis(viaPoint, bus.direction)
  const spreadLaneDistance =
    viaDiameter / 2 +
    traceWidth / 2 +
    clearance +
    1e-3 +
    spreadLaneIndex * (traceWidth + clearance)
  const useNestedSpread =
    interstitialEscape &&
    directionalPitch >= spreadLaneDistance + viaDiameter / 2 + clearance
  const spreadPoint = useNestedSpread
    ? makePoint({
        axis: viaAxis + sign * spreadLaneDistance,
        perpendicularAxis: viaPerpendicularAxis,
        direction: bus.direction,
      })
    : viaPoint
  const targetLayerDoglegAxis = useNestedSpread
    ? getAxis(spreadPoint, bus.direction)
    : viaAxis + sign * Math.abs(track - viaPerpendicularAxis)
  const doglegPoint = makePoint({
    axis: targetLayerDoglegAxis,
    perpendicularAxis: track,
    direction: bus.direction,
  })
  const boundarySign = directionSign(boundaryDirection)
  const boundaryExitAxis = getExitAxis(bus, boundaryDirection)
  const boundaryTargetTrack =
    fixedBoundaryTrack ??
    (cornerSide && bus.exitEdge
      ? getCornerTargetTrack({
          bus,
          connection: preparedConnection,
          cornerExitLaneOffset,
          traceWidth,
          viaDiameter,
          clearance,
          layerNames,
          targetLayer,
          cornerBandTargetTrackOffset,
        })
      : usesLayeredWindingChannel
        ? getBoundaryTargetTrack({
            bus,
            connection: preparedConnection,
            boundaryDirection,
            traceWidth,
            clearance,
            layerNames,
            targetLayer,
          })
        : track)
  const connectionRank = getConnectionRank(bus, preparedConnection)
  const localCornerSide = getLocalCornerSide(bus)
  const localChannelLaneIndex =
    localCornerSide === "maximum"
      ? cornerLocalChannelLaneOffset + connectionRank
      : cornerLocalChannelLaneOffset +
        bus.connections.length -
        1 -
        connectionRank
  const globalBoundarySlot = cornerBoundaryChannelLaneOffset + connectionRank
  const boundaryBandConnectionCount = Math.max(
    bus.connections.length,
    bus.cornerBandConnectionCount ?? bus.connections.length,
  )
  const boundaryChannelLaneIndex =
    boundarySign > 0
      ? globalBoundarySlot
      : boundaryBandConnectionCount - 1 - globalBoundarySlot
  const channelPitch = usesLayeredWindingChannel
    ? viaDiameter / 2 + traceWidth / 2 + clearance
    : traceWidth + clearance
  const localChannelAxis =
    getExitAxis(bus, bus.direction) -
    sign *
      (viaDiameter / 2 +
        traceWidth / 2 +
        clearance +
        localChannelLaneIndex * channelPitch)
  const boundaryChannelAxis =
    boundaryExitAxis -
    boundarySign *
      (viaDiameter / 2 +
        traceWidth / 2 +
        clearance +
        boundaryChannelLaneIndex * channelPitch)
  const localChannelSourcePoint = makePoint({
    axis: localChannelAxis,
    perpendicularAxis: track,
    direction: bus.direction,
  })
  const localChannelTargetPoint = makePoint({
    axis: boundaryChannelAxis,
    perpendicularAxis: localChannelAxis,
    direction: boundaryDirection,
  })
  const boundaryChannelTargetPoint = makePoint({
    axis: boundaryChannelAxis,
    perpendicularAxis: boundaryTargetTrack,
    direction: boundaryDirection,
  })
  const windingInputTransitionPoint =
    isHorizontal(bus.direction) !== isHorizontal(boundaryDirection)
      ? localChannelTargetPoint
      : makePoint({
          axis: boundaryChannelAxis,
          perpendicularAxis: track,
          direction: boundaryDirection,
        })
  const exitPoint = terminateAtVia
    ? viaPoint
    : cornerSide ||
        usesLayeredWindingChannel ||
        fixedBoundaryTrack !== undefined
      ? makePoint({
          axis: boundaryExitAxis,
          perpendicularAxis: boundaryTargetTrack,
          direction: boundaryDirection,
        })
      : makePoint({
          axis: exitAxis,
          perpendicularAxis: track,
          direction: bus.direction,
        })
  const additionalVias: NonNullable<FanoutRoutePlan["additionalVias"]> = []
  if (usesLayeredWindingChannel && windingCrossoverLayer) {
    const escapePoints = chamferOrthogonalPolyline(
      [
        viaPoint,
        ...(useNestedSpread ? [spreadPoint] : []),
        doglegPoint,
        ...(isHorizontal(bus.direction) !== isHorizontal(boundaryDirection)
          ? [localChannelSourcePoint]
          : []),
        windingInputTransitionPoint,
      ],
      Math.max(traceWidth + clearance, traceWidth * 2),
    )
    appendLayerPath(
      { points: escapePoints, layer: escapeLayer },
      { segments, route, traceWidth },
    )

    appendTransitionVia(
      {
        center: windingInputTransitionPoint,
        fromLayer: escapeLayer,
        toLayer: windingCrossoverLayer,
      },
      {
        additionalVias,
        route,
        layerNames,
        allowBlindAndBuriedVias,
        viaDiameter,
        viaHoleDiameter,
        traceWidth,
      },
    )
    appendLayerPath(
      {
        points: [windingInputTransitionPoint, boundaryChannelTargetPoint],
        layer: windingCrossoverLayer,
      },
      { segments, route, traceWidth },
    )
    appendTransitionVia(
      {
        center: boundaryChannelTargetPoint,
        fromLayer: windingCrossoverLayer,
        toLayer: escapeLayer,
      },
      {
        additionalVias,
        route,
        layerNames,
        allowBlindAndBuriedVias,
        viaDiameter,
        viaHoleDiameter,
        traceWidth,
      },
    )
    appendLayerPath(
      { points: [boundaryChannelTargetPoint, exitPoint], layer: escapeLayer },
      { segments, route, traceWidth },
    )
  } else {
    const targetLayerPoints = terminateAtVia
      ? [viaPoint]
      : cornerSide
        ? chamferOrthogonalPolyline(
            [
              viaPoint,
              ...(useNestedSpread ? [spreadPoint] : []),
              doglegPoint,
              localChannelSourcePoint,
              ...(isHorizontal(bus.direction) !==
              isHorizontal(boundaryDirection)
                ? [localChannelTargetPoint]
                : []),
              boundaryChannelTargetPoint,
              exitPoint,
            ],
            Math.max(traceWidth + clearance, traceWidth * 2),
          )
        : useNestedSpread
          ? chamferOrthogonalPolyline(
              [viaPoint, spreadPoint, doglegPoint, exitPoint],
              Math.max(traceWidth + clearance, traceWidth * 2),
            )
          : [viaPoint, doglegPoint, exitPoint]
    appendLayerPath(
      { points: targetLayerPoints, layer: escapeLayer },
      { segments, route, traceWidth },
    )
  }

  return { exitPoint, additionalVias }
}
