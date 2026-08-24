import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  getCornerBandSide,
  getDirectionForExitEdge,
  getExitEdgeForDirection,
} from "./boundary-exit"
import { createFanoutOutputIds } from "./fanout-output-ids"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import { getLayerSpan } from "./layer-names"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "./net-identity"
import type {
  Bounds,
  FanoutDirection,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "./types"
import { segmentIsLegalTerminalBodyEscape } from "./validate-routed-copper-drc"

export type RouteBusStaticClearanceCache = Map<string, boolean>

export interface RouteBusParams {
  srj: SimpleRouteJson
  bus: PreparedBus
  targetLayer: string
  acceptedPlans: FanoutRoutePlan[]
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  compactBusTracks: boolean
  allowSameNetMerges?: boolean
  staticClearanceCache?: RouteBusStaticClearanceCache
  blockingBusCounts?: Map<string, number>
}

interface TrackCandidate {
  value: number
  kind: "corridor" | "gap" | "margin" | "preferred"
}

type ViaHandedness = -1 | 0 | 1

function isHorizontal(direction: FanoutDirection): boolean {
  return direction === "left" || direction === "right"
}

function directionSign(direction: FanoutDirection): number {
  return direction === "right" || direction === "up" ? 1 : -1
}

function getAxis(point: Point2D, direction: FanoutDirection): number {
  return isHorizontal(direction) ? point.x : point.y
}

function getPerpendicularAxis(
  point: Point2D,
  direction: FanoutDirection,
): number {
  return isHorizontal(direction) ? point.y : point.x
}

function getCornerSide(bus: PreparedBus): "minimum" | "maximum" | undefined {
  return getCornerBandSide(bus.exitEdge, bus.preferredExit)
}

function getLocalCornerSide(
  bus: PreparedBus,
): "minimum" | "maximum" | undefined {
  return getCornerBandSide(
    getExitEdgeForDirection(bus.direction),
    bus.preferredExit,
  )
}

function busUsesCoordinatedWindingChannel(bus: PreparedBus): boolean {
  const routableLayers = bus.routableEscapeLayers ?? bus.allowedLayers
  return Boolean(
    bus.exitEdge &&
      bus.termination.type === "boundary" &&
      (routableLayers?.length ?? 0) >= 2 &&
      bus.connections.length > 0 &&
      bus.connections.every(
        (connection) => connection.hasExplicitLayeredExitTarget === true,
      ),
  )
}

function getStableConnectionIdentity(
  connection: PreparedConnection["connection"],
): string {
  if (
    "source_trace_id" in connection &&
    typeof connection.source_trace_id === "string"
  ) {
    return connection.source_trace_id
  }
  return connection.name
}

function getWindingTargetRank(params: {
  bus: PreparedBus
  connection: PreparedConnection
  boundaryDirection: FanoutDirection
  layerNames: readonly string[]
}): { rank: number; connectionCount: number } {
  const { bus, connection, boundaryDirection, layerNames } = params
  const orderedConnections = bus.connections.toSorted((first, second) => {
    const axisDifference =
      getPerpendicularAxis(
        first.exitTargetPoint ?? first.targetPoint,
        boundaryDirection,
      ) -
      getPerpendicularAxis(
        second.exitTargetPoint ?? second.targetPoint,
        boundaryDirection,
      )
    if (Math.abs(axisDifference) > 1e-9) return axisDifference

    const firstLayer = first.exitTargetPoint?.layer
    const secondLayer = second.exitTargetPoint?.layer
    const layerDifference =
      layerNames.indexOf(firstLayer ?? "") -
      layerNames.indexOf(secondLayer ?? "")
    if (layerDifference !== 0) return layerDifference

    const firstStableId = getStableConnectionIdentity(first.connection)
    const secondStableId = getStableConnectionIdentity(second.connection)
    return (
      firstStableId.localeCompare(secondStableId) ||
      first.connectionIndex - second.connectionIndex
    )
  })
  const rank = orderedConnections.findIndex(
    (candidate) => candidate.connectionIndex === connection.connectionIndex,
  )
  if (rank < 0) {
    throw new Error(
      `FanoutSolver: connection "${connection.connection.name}" is missing from winding order`,
    )
  }
  return { rank, connectionCount: orderedConnections.length }
}

function getWindingCrossoverLayer(params: {
  bus: PreparedBus
  escapeLayer: string
}): string | undefined {
  const { bus, escapeLayer } = params
  return (bus.routableEscapeLayers ?? bus.allowedLayers)?.find(
    (layer) => layer !== escapeLayer,
  )
}

function getCornerTargetTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  cornerExitLaneOffset: number
  traceWidth: number
  viaDiameter: number
  clearance: number
  layerNames: readonly string[]
}): number {
  const {
    bus,
    connection,
    cornerExitLaneOffset,
    traceWidth,
    viaDiameter,
    clearance,
    layerNames,
  } = params
  const side = getCornerSide(bus)
  if (!side || !bus.exitEdge) {
    return getPerpendicularAxis(
      connection.exitTargetPoint ?? connection.targetPoint,
      bus.direction,
    )
  }
  const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
  const boundaryMinimum = isHorizontal(boundaryDirection)
    ? bus.sharedBoundary.minY
    : bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(boundaryDirection)
    ? bus.sharedBoundary.maxY
    : bus.sharedBoundary.maxX
  const pitch = Math.max(traceWidth + clearance, viaDiameter + clearance)
  const baseBandCenter =
    boundaryMinimum +
    (boundaryMaximum - boundaryMinimum) * (side === "minimum" ? 0.25 : 0.75)
  const windingTarget = busUsesCoordinatedWindingChannel(bus)
    ? getWindingTargetRank({
        bus,
        connection,
        boundaryDirection,
        layerNames,
      })
    : undefined
  const bandConnectionCount = Math.max(
    bus.connections.length,
    bus.cornerBandConnectionCount ?? bus.connections.length,
    cornerExitLaneOffset + (windingTarget?.connectionCount ?? 0),
  )
  const firstTrack = baseBandCenter - ((bandConnectionCount - 1) * pitch) / 2
  const rank = windingTarget?.rank ?? getConnectionRank(bus, connection)
  const globalSlot = cornerExitLaneOffset + rank
  const reverseSlotOrder =
    !windingTarget &&
    (side === "maximum") === directionSign(boundaryDirection) > 0
  const orientedSlot = reverseSlotOrder
    ? bandConnectionCount - 1 - globalSlot
    : globalSlot
  return firstTrack + orientedSlot * pitch
}

function getCornerLaneOffsets(
  bus: PreparedBus,
  acceptedPlans: readonly FanoutRoutePlan[],
): { exit: number; localChannel: number; boundaryChannel: number } {
  const side = getCornerSide(bus)
  if (!side || !bus.exitEdge) {
    return { exit: 0, localChannel: 0, boundaryChannel: 0 }
  }
  const cornerPlans = acceptedPlans.filter(
    (plan) => plan.exitEdge && plan.cornerBandSide !== undefined,
  )
  const plansOnExitEdge = cornerPlans.filter(
    (plan) => plan.exitEdge === bus.exitEdge && plan.cornerBandSide === side,
  )
  const plansOnLocalEdge = cornerPlans.filter(
    (plan) => plan.direction === bus.direction,
  )
  return {
    exit: plansOnExitEdge.length,
    localChannel: plansOnLocalEdge.length,
    boundaryChannel: plansOnExitEdge.length,
  }
}

function makePoint(
  axis: number,
  perpendicularAxis: number,
  direction: FanoutDirection,
): Point2D {
  return isHorizontal(direction)
    ? { x: axis, y: perpendicularAxis }
    : { x: perpendicularAxis, y: axis }
}

function getExitAxis(
  bus: PreparedBus,
  direction: FanoutDirection = bus.direction,
): number {
  switch (direction) {
    case "right":
      return bus.sharedBoundary.maxX
    case "left":
      return bus.sharedBoundary.minX
    case "up":
      return bus.sharedBoundary.maxY
    case "down":
      return bus.sharedBoundary.minY
  }
}

function getDirectionalPitch(bus: PreparedBus): number {
  return isHorizontal(bus.direction) ? bus.pitchX : bus.pitchY
}

function getPerpendicularPitch(bus: PreparedBus): number {
  return isHorizontal(bus.direction) ? bus.pitchY : bus.pitchX
}

function getDepthInRows(bus: PreparedBus): number {
  const directionalCoordinates = (
    isHorizontal(bus.direction) ? bus.xCoordinates : bus.yCoordinates
  ).toSorted((a, b) => a - b)
  const averageDirectionalSource =
    bus.connections.reduce(
      (sum, candidate) => sum + getAxis(candidate.sourcePoint, bus.direction),
      0,
    ) / bus.connections.length
  const outwardCoordinate =
    directionSign(bus.direction) > 0
      ? directionalCoordinates.at(-1)!
      : directionalCoordinates[0]!

  return (
    Math.abs(outwardCoordinate - averageDirectionalSource) /
    getDirectionalPitch(bus)
  )
}

function busIsOnOutwardComponentEdge(bus: PreparedBus): boolean {
  const directionalCoordinates = isHorizontal(bus.direction)
    ? bus.xCoordinates
    : bus.yCoordinates
  const averageDirectionalSource =
    bus.connections.reduce(
      (sum, connection) => sum + getAxis(connection.sourcePoint, bus.direction),
      0,
    ) / bus.connections.length
  const outwardCoordinate =
    directionSign(bus.direction) > 0
      ? Math.max(...directionalCoordinates)
      : Math.min(...directionalCoordinates)
  return Math.abs(averageDirectionalSource - outwardCoordinate) < 1e-6
}

function getConnectionRank(
  bus: PreparedBus,
  connection: PreparedConnection,
): number {
  const connectionRank = [...bus.connections]
    .sort(
      (a, b) =>
        getPerpendicularAxis(a.sourcePoint, bus.direction) -
        getPerpendicularAxis(b.sourcePoint, bus.direction),
    )
    .findIndex(
      (candidate) => candidate.connectionIndex === connection.connectionIndex,
    )
  if (connectionRank < 0) {
    throw new Error(
      `FanoutSolver: connection "${connection.connection.name}" is missing from bus "${bus.busId}"`,
    )
  }
  return connectionRank
}

function getRoutableBounds(
  srjBounds: SimpleRouteJson["bounds"],
  sharedBoundary: Bounds,
): SimpleRouteJson["bounds"] {
  // Fanout routes must reach the shared boundary and terminate exactly on it.
  // When that boundary sits outside srj.bounds -- which is what
  // fanoutBoundaryPadding does, since it pads the boundary without widening
  // the routing area -- containment has to follow the boundary, or every plan
  // is rejected before its geometry is ever considered.
  return {
    minX: Math.min(srjBounds.minX, sharedBoundary.minX),
    maxX: Math.max(srjBounds.maxX, sharedBoundary.maxX),
    minY: Math.min(srjBounds.minY, sharedBoundary.minY),
    maxY: Math.max(srjBounds.maxY, sharedBoundary.maxY),
  }
}

function pointIsInsideBounds(
  point: Point2D,
  bounds: SimpleRouteJson["bounds"],
): boolean {
  return (
    point.x >= bounds.minX - 1e-6 &&
    point.x <= bounds.maxX + 1e-6 &&
    point.y >= bounds.minY - 1e-6 &&
    point.y <= bounds.maxY + 1e-6
  )
}

function getTracksInSpan(
  minimum: number,
  maximum: number,
  traceWidth: number,
  clearance: number,
  kind: TrackCandidate["kind"],
): TrackCandidate[] {
  const freeWidth = maximum - minimum
  const trackCount = Math.floor(
    (freeWidth - clearance) / (traceWidth + clearance) + 1e-9,
  )
  if (trackCount < 1) return []
  const usedWidth = trackCount * traceWidth + (trackCount - 1) * clearance
  const firstTrack = minimum + (freeWidth - usedWidth) / 2 + traceWidth / 2
  return Array.from({ length: trackCount }, (_, index) => ({
    value: firstTrack + index * (traceWidth + clearance),
    kind,
  }))
}

function getTrackCandidates(params: {
  bus: PreparedBus
  connection: PreparedConnection
  preferredTrack: number
  traceWidth: number
  clearance: number
}): TrackCandidate[] {
  const { bus, connection, preferredTrack, traceWidth, clearance } = params
  const coordinates = (
    isHorizontal(bus.direction) ? bus.yCoordinates : bus.xCoordinates
  ).toSorted((a, b) => a - b)
  const obstacleHalfSize = Math.max(
    ...bus.componentObstacles.map((obstacle) =>
      isHorizontal(bus.direction) ? obstacle.height / 2 : obstacle.width / 2,
    ),
  )
  const boundaryMinimum = isHorizontal(bus.direction)
    ? bus.sharedBoundary.minY
    : bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(bus.direction)
    ? bus.sharedBoundary.maxY
    : bus.sharedBoundary.maxX
  const maximumJog = boundaryMaximum - boundaryMinimum
  const ladderMinimum = boundaryMinimum
  const ladderMaximum = boundaryMaximum
  const tracks: TrackCandidate[] = [
    { value: preferredTrack, kind: "preferred" },
    ...getTracksInSpan(
      ladderMinimum,
      coordinates[0]! - obstacleHalfSize,
      traceWidth,
      clearance,
      "margin",
    ),
  ]
  for (let index = 0; index < coordinates.length; index++) {
    tracks.push({ value: coordinates[index]!, kind: "corridor" })
    if (index < coordinates.length - 1) {
      tracks.push(
        ...getTracksInSpan(
          coordinates[index]! + obstacleHalfSize,
          coordinates[index + 1]! - obstacleHalfSize,
          traceWidth,
          clearance,
          "gap",
        ),
      )
    }
  }
  tracks.push(
    ...getTracksInSpan(
      coordinates.at(-1)! + obstacleHalfSize,
      ladderMaximum,
      traceWidth,
      clearance,
      "margin",
    ),
  )

  const sourceTrack = getPerpendicularAxis(
    connection.sourcePoint,
    bus.direction,
  )
  const componentCenter = (coordinates[0]! + coordinates.at(-1)!) / 2
  return tracks
    .filter((track) => Math.abs(track.value - sourceTrack) <= maximumJog + 1e-9)
    .filter(
      (track, index, candidates) =>
        candidates.findIndex(
          (candidate) => Math.abs(candidate.value - track.value) < 1e-9,
        ) === index,
    )
    .sort(
      (a, b) =>
        Math.abs(a.value - preferredTrack) -
        Math.abs(b.value - preferredTrack) -
        (Math.abs(a.value - componentCenter) -
          Math.abs(b.value - componentCenter)) *
          1e-3,
    )
}

function getPreferredTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  traceWidth: number
}): number {
  const preferredTrack =
    getCornerSide(params.bus) || busUsesCoordinatedWindingChannel(params.bus)
      ? getPerpendicularAxis(
          params.connection.sourcePoint,
          params.bus.direction,
        )
      : getPerpendicularAxis(
          params.connection.exitTargetPoint ?? params.connection.targetPoint,
          params.bus.direction,
        )
  const boundaryMinimum = isHorizontal(params.bus.direction)
    ? params.bus.sharedBoundary.minY
    : params.bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(params.bus.direction)
    ? params.bus.sharedBoundary.maxY
    : params.bus.sharedBoundary.maxX

  return Math.max(
    boundaryMinimum + params.traceWidth / 2,
    Math.min(boundaryMaximum - params.traceWidth / 2, preferredTrack),
  )
}

function getLegacyPreferredTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  targetUsesVia: boolean
  interstitialEscape: boolean
  compactBusTracks: boolean
  traceWidth: number
  viaDiameter: number
  clearance: number
}): number {
  const {
    bus,
    connection,
    targetUsesVia,
    interstitialEscape,
    compactBusTracks,
    traceWidth,
    viaDiameter,
    clearance,
  } = params
  const perpendicularCoordinates = (
    isHorizontal(bus.direction) ? bus.yCoordinates : bus.xCoordinates
  ).toSorted((a, b) => a - b)
  const sourceTrack = getPerpendicularAxis(
    connection.sourcePoint,
    bus.direction,
  )
  if (compactBusTracks) {
    const connectionRank = getConnectionRank(bus, connection)
    const componentCenter =
      (perpendicularCoordinates[0]! + perpendicularCoordinates.at(-1)!) / 2
    return (
      componentCenter +
      (connectionRank - (bus.connections.length - 1) / 2) *
        (traceWidth + clearance)
    )
  }
  if (!targetUsesVia || !interstitialEscape) return sourceTrack

  const depthInRows = getDepthInRows(bus)
  const trackPitch = traceWidth + clearance
  const halfConnectionCount = Math.ceil(bus.connections.length / 2)
  const sideBandWidth = (halfConnectionCount - 1) * trackPitch
  const bandSeparation = viaDiameter / 2 + traceWidth / 2 + clearance + 1e-3
  const depthIndex = Math.round(depthInRows) + 1
  const nearOffset =
    depthIndex * bandSeparation + (depthIndex - 1) * sideBandWidth
  const connectionRank = getConnectionRank(bus, connection)
  const componentMinimum = perpendicularCoordinates[0]!
  const componentMaximum = perpendicularCoordinates.at(-1)!
  const requestedTrack =
    connectionRank < halfConnectionCount
      ? componentMinimum -
        nearOffset -
        (halfConnectionCount - connectionRank - 1) * trackPitch
      : componentMaximum +
        nearOffset +
        (connectionRank - halfConnectionCount) * trackPitch
  const boundaryMinimum = isHorizontal(bus.direction)
    ? bus.sharedBoundary.minY
    : bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(bus.direction)
    ? bus.sharedBoundary.maxY
    : bus.sharedBoundary.maxX

  return Math.max(
    boundaryMinimum + traceWidth / 2,
    Math.min(boundaryMaximum - traceWidth / 2, requestedTrack),
  )
}

function getConnectionOrders(bus: PreparedBus): PreparedConnection[][] {
  const sign = directionSign(bus.direction)
  const outwardFirst = [...bus.connections].sort((a, b) => {
    const directionalDifference =
      sign *
      (getAxis(b.sourcePoint, bus.direction) -
        getAxis(a.sourcePoint, bus.direction))
    if (Math.abs(directionalDifference) > 1e-6) {
      return directionalDifference
    }
    return (
      getPerpendicularAxis(a.sourcePoint, bus.direction) -
      getPerpendicularAxis(b.sourcePoint, bus.direction)
    )
  })
  const perpendicularFirst = [...bus.connections].sort(
    (a, b) =>
      getPerpendicularAxis(a.sourcePoint, bus.direction) -
        getPerpendicularAxis(b.sourcePoint, bus.direction) ||
      sign *
        (getAxis(b.sourcePoint, bus.direction) -
          getAxis(a.sourcePoint, bus.direction)),
  )
  const orders = [
    outwardFirst,
    [...outwardFirst].reverse(),
    perpendicularFirst,
    [...perpendicularFirst].reverse(),
  ]
  for (let offset = 1; offset < Math.min(outwardFirst.length, 8); offset++) {
    orders.push([
      ...outwardFirst.slice(offset),
      ...outwardFirst.slice(0, offset),
    ])
  }
  return orders
}

function appendSegment(
  segments: RoutedSegment[],
  start: Point2D,
  end: Point2D,
  width: number,
  layer: string,
): void {
  if (distance(start, end) < 1e-9) return
  segments.push({ start, end, width, layer })
}

function chamferOrthogonalPolyline(
  points: Point2D[],
  requestedChamfer: number,
): Point2D[] {
  if (points.length < 3) return points
  const chamfered: Point2D[] = [points[0]!]

  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!
    const corner = points[index]!
    const next = points[index + 1]!
    const incomingLength = distance(previous, corner)
    const outgoingLength = distance(corner, next)
    if (incomingLength < 1e-9 || outgoingLength < 1e-9) continue
    const incomingUnit = {
      x: (corner.x - previous.x) / incomingLength,
      y: (corner.y - previous.y) / incomingLength,
    }
    const outgoingUnit = {
      x: (next.x - corner.x) / outgoingLength,
      y: (next.y - corner.y) / outgoingLength,
    }
    const dot =
      incomingUnit.x * outgoingUnit.x + incomingUnit.y * outgoingUnit.y
    if (Math.abs(dot) > 1e-6) {
      chamfered.push(corner)
      continue
    }

    const chamfer = Math.min(
      requestedChamfer,
      incomingLength / 2,
      outgoingLength / 2,
    )
    chamfered.push({
      x: corner.x - incomingUnit.x * chamfer,
      y: corner.y - incomingUnit.y * chamfer,
    })
    chamfered.push({
      x: corner.x + outgoingUnit.x * chamfer,
      y: corner.y + outgoingUnit.y * chamfer,
    })
  }

  chamfered.push(points.at(-1)!)
  return chamfered
}

function buildPlan(params: {
  preparedConnection: PreparedConnection
  bus: PreparedBus
  targetLayer: string
  track: number
  exitAxis: number
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  viaHandedness: ViaHandedness
  interstitialEscape: boolean
  spreadLaneIndex: number
  cornerExitLaneOffset: number
  cornerLocalChannelLaneOffset: number
  cornerBoundaryChannelLaneOffset: number
  clearance: number
  terminateAtVia: boolean
}): FanoutRoutePlan {
  const {
    preparedConnection,
    bus,
    targetLayer,
    track,
    exitAxis,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    viaHandedness,
    interstitialEscape,
    spreadLaneIndex,
    cornerExitLaneOffset,
    cornerLocalChannelLaneOffset,
    cornerBoundaryChannelLaneOffset,
    clearance,
    terminateAtVia,
  } = params
  const sourcePoint = {
    x: preparedConnection.sourcePoint.x,
    y: preparedConnection.sourcePoint.y,
  }
  const escapeLayer = targetLayer
  const windingCrossoverLayer = busUsesCoordinatedWindingChannel(bus)
    ? getWindingCrossoverLayer({
        bus,
        escapeLayer,
      })
    : undefined
  const usesLayeredWindingChannel = Boolean(windingCrossoverLayer)
  const sign = directionSign(bus.direction)
  const directionalPitch = getDirectionalPitch(bus)
  const perpendicularPitch = getPerpendicularPitch(bus)
  const targetUsesVia = escapeLayer !== preparedConnection.sourceLayer
  const directionalPadSize = isHorizontal(bus.direction)
    ? preparedConnection.sourceObstacle.width
    : preparedConnection.sourceObstacle.height
  const initialEscapeDistance =
    targetUsesVia && !busIsOnOutwardComponentEdge(bus)
      ? directionalPadSize >= directionalPitch
        ? directionalPadSize / 2 + viaDiameter / 2 + clearance + 1e-3
        : directionalPitch * 0.5
      : !targetUsesVia
        ? directionalPadSize / 2 + traceWidth / 2 + clearance + 1e-3
        : Math.max(
            directionalPitch * 0.5,
            directionalPadSize / 2 +
              (targetUsesVia ? viaDiameter : traceWidth) / 2 +
              clearance +
              1e-3,
          )
  const viaAxis =
    getAxis(sourcePoint, bus.direction) + sign * initialEscapeDistance
  const sourcePerpendicularAxis = getPerpendicularAxis(
    sourcePoint,
    bus.direction,
  )
  const viaPerpendicularAxis =
    sourcePerpendicularAxis + viaHandedness * perpendicularPitch * 0.5
  const viaPoint = makePoint(viaAxis, viaPerpendicularAxis, bus.direction)
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
    ? makePoint(
        viaAxis + sign * spreadLaneDistance,
        viaPerpendicularAxis,
        bus.direction,
      )
    : viaPoint
  const targetLayerDoglegAxis = useNestedSpread
    ? getAxis(spreadPoint, bus.direction)
    : viaAxis + sign * Math.abs(track - viaPerpendicularAxis)
  const doglegPoint = makePoint(targetLayerDoglegAxis, track, bus.direction)
  const cornerSide = getCornerSide(bus)
  const boundaryDirection = bus.exitEdge
    ? getDirectionForExitEdge(bus.exitEdge)
    : bus.direction
  const boundarySign = directionSign(boundaryDirection)
  const boundaryExitAxis = getExitAxis(bus, boundaryDirection)
  const boundaryTargetTrack =
    cornerSide && bus.exitEdge
      ? getCornerTargetTrack({
          bus,
          connection: preparedConnection,
          cornerExitLaneOffset,
          traceWidth,
          viaDiameter,
          clearance,
          layerNames,
        })
      : usesLayeredWindingChannel
        ? getPerpendicularAxis(
            preparedConnection.exitTargetPoint ??
              preparedConnection.targetPoint,
            boundaryDirection,
          )
        : track
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
  const channelInset = (laneIndex: number) =>
    viaDiameter / 2 + traceWidth / 2 + clearance + laneIndex * channelPitch
  const localChannelAxis =
    getExitAxis(bus, bus.direction) - sign * channelInset(localChannelLaneIndex)
  const boundaryChannelAxis =
    boundaryExitAxis - boundarySign * channelInset(boundaryChannelLaneIndex)
  const localChannelSourcePoint = makePoint(
    localChannelAxis,
    track,
    bus.direction,
  )
  const localChannelTargetPoint = makePoint(
    boundaryChannelAxis,
    localChannelAxis,
    boundaryDirection,
  )
  const boundaryChannelTargetPoint = makePoint(
    boundaryChannelAxis,
    boundaryTargetTrack,
    boundaryDirection,
  )
  const windingInputTransitionPoint =
    isHorizontal(bus.direction) !== isHorizontal(boundaryDirection)
      ? localChannelTargetPoint
      : makePoint(boundaryChannelAxis, track, boundaryDirection)
  const exitPoint = terminateAtVia
    ? viaPoint
    : cornerSide || usesLayeredWindingChannel
      ? makePoint(boundaryExitAxis, boundaryTargetTrack, boundaryDirection)
      : makePoint(exitAxis, track, bus.direction)
  const segments: RoutedSegment[] = []
  const route: SimplifiedPcbTrace["route"] = []

  route.push({
    route_type: "wire",
    x: sourcePoint.x,
    y: sourcePoint.y,
    width: traceWidth,
    layer: preparedConnection.sourceLayer,
    start_pcb_port_id: preparedConnection.sourcePoint.pcb_port_id,
  })
  appendSegment(
    segments,
    sourcePoint,
    viaPoint,
    traceWidth,
    preparedConnection.sourceLayer,
  )
  route.push({
    route_type: "wire",
    x: viaPoint.x,
    y: viaPoint.y,
    width: traceWidth,
    layer: preparedConnection.sourceLayer,
  })

  let via: FanoutRoutePlan["via"]
  if (targetLayer !== preparedConnection.sourceLayer) {
    const spanLayers = getLayerSpan(
      preparedConnection.sourceLayer,
      targetLayer,
      layerNames,
    )
    via = {
      center: viaPoint,
      diameter: viaDiameter,
      holeDiameter: viaHoleDiameter,
      fromLayer: preparedConnection.sourceLayer,
      toLayer: targetLayer,
      spanLayers,
    }
    route.push({
      route_type: "via",
      x: viaPoint.x,
      y: viaPoint.y,
      from_layer: preparedConnection.sourceLayer,
      to_layer: targetLayer,
      via_diameter: viaDiameter,
      via_hole_diameter: viaHoleDiameter,
    })
    route.push({
      route_type: "wire",
      x: viaPoint.x,
      y: viaPoint.y,
      width: traceWidth,
      layer: targetLayer,
    })
  }

  const appendLayerPath = (points: Point2D[], layer: string): void => {
    for (let index = 1; index < points.length; index++) {
      const previousPoint = points[index - 1]!
      const nextPoint = points[index]!
      appendSegment(segments, previousPoint, nextPoint, traceWidth, layer)
      route.push({
        route_type: "wire",
        x: nextPoint.x,
        y: nextPoint.y,
        width: traceWidth,
        layer,
      })
    }
  }

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
    appendLayerPath(escapePoints, escapeLayer)

    const appendTransitionVia = (
      center: Point2D,
      fromLayer: string,
      toLayer: string,
    ): void => {
      if (fromLayer === toLayer) return
      additionalVias.push({
        center,
        diameter: viaDiameter,
        holeDiameter: viaHoleDiameter,
        fromLayer,
        toLayer,
        spanLayers: getLayerSpan(fromLayer, toLayer, layerNames),
      })
      route.push({
        route_type: "via",
        x: center.x,
        y: center.y,
        from_layer: fromLayer,
        to_layer: toLayer,
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      })
      route.push({
        route_type: "wire",
        x: center.x,
        y: center.y,
        width: traceWidth,
        layer: toLayer,
      })
    }

    appendTransitionVia(
      windingInputTransitionPoint,
      escapeLayer,
      windingCrossoverLayer,
    )
    appendLayerPath(
      [windingInputTransitionPoint, boundaryChannelTargetPoint],
      windingCrossoverLayer,
    )
    appendTransitionVia(
      boundaryChannelTargetPoint,
      windingCrossoverLayer,
      escapeLayer,
    )
    appendLayerPath([boundaryChannelTargetPoint, exitPoint], escapeLayer)
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
    appendLayerPath(targetLayerPoints, escapeLayer)
  }

  const outputIds = createFanoutOutputIds({
    connectionName: preparedConnection.connection.name,
    sourcePointIndex: preparedConnection.sourcePointIndex,
  })
  return {
    busId: bus.busId,
    connectionName: preparedConnection.connection.name,
    connectionIndex: preparedConnection.connectionIndex,
    sourcePointIndex: preparedConnection.sourcePointIndex,
    sourcePoint: preparedConnection.sourcePoint,
    sourceObstacle: preparedConnection.sourceObstacle,
    sourceLayer: preparedConnection.sourceLayer,
    targetPoint: preparedConnection.targetPoint,
    targetLayer: escapeLayer,
    termination: bus.termination,
    direction: bus.direction,
    ...(bus.exitEdge ? { exitEdge: bus.exitEdge } : {}),
    ...(cornerSide ? { cornerBandSide: cornerSide } : {}),
    exitPoint,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: outputIds.traceId,
      connection_name: preparedConnection.connection.name,
      connectsTo: [
        ...(preparedConnection.sourcePoint.pointId
          ? [preparedConnection.sourcePoint.pointId]
          : []),
        ...(preparedConnection.sourcePoint.pcb_port_id
          ? [preparedConnection.sourcePoint.pcb_port_id]
          : []),
        outputIds.boundaryExitPointId,
      ],
      route,
    },
    segments,
    via,
    ...(additionalVias.length > 0 ? { additionalVias } : {}),
    length: segments.reduce(
      (total, segment) => total + distance(segment.start, segment.end),
      0,
    ),
  }
}

function getPointLayer(point: PreparedConnection["targetPoint"]): string {
  const layer = "layer" in point ? point.layer : point.layers[0]
  if (!layer) {
    throw new Error("FanoutSolver: plane endpoint has no copper layer")
  }
  return layer
}

function getPlaneEndpointViaCandidates(params: {
  preparedConnection: PreparedConnection
  bus: PreparedBus
  viaDiameter: number
  clearance: number
}): Point2D[] {
  const { preparedConnection, bus, viaDiameter, clearance } = params
  const { sourcePoint, targetPoint } = preparedConnection
  const nearbyEndpointLimit = Math.max(bus.pitchX, bus.pitchY) * 0.5
  if (
    distance(sourcePoint, targetPoint) <= 1e-6 ||
    distance(sourcePoint, targetPoint) > nearbyEndpointLimit
  ) {
    return []
  }

  const preferred = (() => {
    switch (bus.direction) {
      case "left":
        return { x: -1, y: 0 }
      case "right":
        return { x: 1, y: 0 }
      case "up":
        return { x: 0, y: 1 }
      case "down":
        return { x: 0, y: -1 }
    }
  })()
  const diagonal = Math.SQRT1_2
  const directions = [
    preferred,
    ...[
      { x: diagonal, y: diagonal },
      { x: diagonal, y: -diagonal },
      { x: -diagonal, y: diagonal },
      { x: -diagonal, y: -diagonal },
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ].toSorted(
      (first, second) =>
        second.x * preferred.x +
        second.y * preferred.y -
        (first.x * preferred.x + first.y * preferred.y),
    ),
  ]
  const minimumRadius = Math.max(viaDiameter, viaDiameter / 2 + clearance)
  const radii = [
    minimumRadius,
    Math.max(minimumRadius, Math.min(bus.pitchX, bus.pitchY) * 0.5),
    Math.max(minimumRadius, Math.min(bus.pitchX, bus.pitchY) * 0.625),
    Math.max(minimumRadius, Math.min(bus.pitchX, bus.pitchY) * 0.75),
  ]
  const candidates: Point2D[] = []
  for (const origin of [sourcePoint, targetPoint]) {
    for (const radius of radii) {
      for (const direction of directions) {
        const candidate = {
          x: origin.x + direction.x * radius,
          y: origin.y + direction.y * radius,
        }
        if (
          distance(candidate, sourcePoint) <= 1e-6 ||
          distance(candidate, targetPoint) <= 1e-6 ||
          candidates.some((existing) => distance(existing, candidate) <= 1e-6)
        ) {
          continue
        }
        candidates.push(candidate)
      }
    }
  }
  return candidates
}

function addPlaneEndpointTerminal(params: {
  plan: FanoutRoutePlan
  preparedConnection: PreparedConnection
  planeLayer: string
  viaPoint: Point2D
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
}): FanoutRoutePlan {
  const {
    plan,
    preparedConnection,
    planeLayer,
    viaPoint,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
  } = params
  const targetPoint = {
    x: preparedConnection.targetPoint.x,
    y: preparedConnection.targetPoint.y,
  }
  const targetEndpointLayer = getPointLayer(preparedConnection.targetPoint)
  const spanLayers = getLayerSpan(planeLayer, targetEndpointLayer, layerNames)
  if (!spanLayers.includes(planeLayer)) {
    throw new Error(
      `FanoutSolver: via for "${preparedConnection.connection.name}" does not cross plane ${planeLayer}`,
    )
  }
  const planeEndpointSegments: RoutedSegment[] = [
    {
      start: viaPoint,
      end: targetPoint,
      width: traceWidth,
      layer: targetEndpointLayer,
    },
  ]
  const via = {
    center: viaPoint,
    diameter: viaDiameter,
    holeDiameter: viaHoleDiameter,
    fromLayer: planeLayer,
    toLayer: targetEndpointLayer,
    spanLayers,
  }
  const outputIds = createFanoutOutputIds({
    connectionName: preparedConnection.connection.name,
    sourcePointIndex: preparedConnection.sourcePointIndex,
  })
  const planeEndpointTrace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: outputIds.planeEndpointTraceId,
    connection_name: preparedConnection.connection.name,
    connectsTo: [
      ...(preparedConnection.targetPoint.pointId
        ? [preparedConnection.targetPoint.pointId]
        : []),
      ...(preparedConnection.targetPoint.pcb_port_id
        ? [preparedConnection.targetPoint.pcb_port_id]
        : []),
      outputIds.planeEndpointPointId,
    ],
    route: [
      {
        route_type: "wire",
        ...viaPoint,
        width: traceWidth,
        layer: planeLayer,
      },
      {
        route_type: "via",
        ...viaPoint,
        from_layer: planeLayer,
        to_layer: targetEndpointLayer,
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      },
      {
        route_type: "wire",
        ...viaPoint,
        width: traceWidth,
        layer: targetEndpointLayer,
      },
      {
        route_type: "wire",
        ...targetPoint,
        width: traceWidth,
        layer: targetEndpointLayer,
      },
    ],
  }
  return {
    ...plan,
    planeEndpointTrace,
    planeEndpointSegments,
    planeEndpointVia: via,
    length:
      plan.length +
      planeEndpointSegments.reduce(
        (total, segment) => total + distance(segment.start, segment.end),
        0,
      ),
  }
}

function segmentIsClearOfObstacles(params: {
  segment: RoutedSegment
  plan: FanoutRoutePlan
  segmentIndex: number
  srj: SimpleRouteJson
  allowSameNetMerges: boolean
  obstacles: Obstacle[]
  clearance: number
}): boolean {
  const {
    segment,
    plan,
    segmentIndex,
    srj,
    allowSameNetMerges,
    obstacles,
    clearance,
  } = params
  for (const obstacle of obstacles) {
    if (!obstacle.layers.includes(segment.layer)) continue
    if (obstacle.connectedTo.includes(plan.connectionName)) continue
    if (
      allowSameNetMerges &&
      obstacleSharesElectricalNet(srj, obstacle, plan.connectionName)
    ) {
      continue
    }
    if (
      segmentIsLegalTerminalBodyEscape({
        inputSrj: srj,
        segment,
        bodyObstacle: obstacle,
        connectionName: plan.connectionName,
      })
    ) {
      continue
    }
    if (
      segmentIndex === 0 &&
      obstacle === plan.sourceObstacle &&
      segment.layer === plan.sourceLayer
    ) {
      continue
    }
    if (
      distanceSegmentToObstacle(segment, obstacle) <
      segment.width / 2 + clearance - 1e-9
    ) {
      return false
    }
  }
  return true
}

function getPlanSegments(plan: FanoutRoutePlan): RoutedSegment[] {
  return [...plan.segments, ...(plan.planeEndpointSegments ?? [])]
}

function getPlanVias(plan: FanoutRoutePlan) {
  return [
    plan.via,
    ...(plan.additionalVias ?? []),
    plan.planeEndpointVia,
  ].filter((via): via is NonNullable<FanoutRoutePlan["via"]> => Boolean(via))
}

function planIsStaticallyClear(params: {
  plan: FanoutRoutePlan
  srj: SimpleRouteJson
  sharedBoundary: Bounds
  clearance: number
  allowSameNetMerges: boolean
}): boolean {
  const { plan, srj, sharedBoundary, clearance, allowSameNetMerges } = params
  const routableBounds = getRoutableBounds(srj.bounds, sharedBoundary)
  if (
    !pointIsInsideBounds(plan.exitPoint, routableBounds) ||
    getPlanSegments(plan).some(
      (segment) =>
        !pointIsInsideBounds(segment.start, routableBounds) ||
        !pointIsInsideBounds(segment.end, routableBounds),
    )
  ) {
    return false
  }
  const segments = getPlanSegments(plan)
  for (let index = 0; index < segments.length; index++) {
    if (
      !segmentIsClearOfObstacles({
        segment: segments[index]!,
        plan,
        segmentIndex: index < plan.segments.length ? index : -1,
        srj,
        allowSameNetMerges,
        obstacles: srj.obstacles,
        clearance,
      })
    ) {
      return false
    }
  }
  for (const via of getPlanVias(plan)) {
    for (const obstacle of srj.obstacles) {
      if (!obstacle.layers.some((layer) => via.spanLayers.includes(layer))) {
        continue
      }
      if (
        allowSameNetMerges &&
        obstacleSharesElectricalNet(srj, obstacle, plan.connectionName)
      ) {
        continue
      }
      if (
        distancePointToObstacle(via.center, obstacle) <
        via.diameter / 2 + clearance - 1e-9
      ) {
        return false
      }
    }
  }

  for (const traceCopper of getAllRoutedTraceCopper(srj)) {
    if (
      plan.connectionName === traceCopper.connectionName ||
      (allowSameNetMerges &&
        connectionsShareElectricalNet(
          srj,
          plan.connectionName,
          traceCopper.connectionName,
        ))
    ) {
      continue
    }
    for (const segment of getPlanSegments(plan)) {
      for (const existingSegment of traceCopper.segments) {
        if (!segmentsAreClear(segment, existingSegment, clearance)) {
          return false
        }
      }
      for (const existingVia of traceCopper.vias) {
        if (
          existingVia.spanLayers.includes(segment.layer) &&
          distancePointToSegment(
            existingVia.center,
            segment.start,
            segment.end,
          ) <
            existingVia.diameter / 2 + segment.width / 2 + clearance - 1e-9
        ) {
          return false
        }
      }
    }
    for (const via of getPlanVias(plan)) {
      for (const existingSegment of traceCopper.segments) {
        if (
          via.spanLayers.includes(existingSegment.layer) &&
          distancePointToSegment(
            via.center,
            existingSegment.start,
            existingSegment.end,
          ) <
            via.diameter / 2 + existingSegment.width / 2 + clearance - 1e-9
        ) {
          return false
        }
      }
      for (const existingVia of traceCopper.vias) {
        if (
          via.spanLayers.some((layer) =>
            existingVia.spanLayers.includes(layer),
          ) &&
          distance(via.center, existingVia.center) <
            (via.diameter + existingVia.diameter) / 2 + clearance - 1e-9
        ) {
          return false
        }
      }
    }
  }

  return true
}

function planIsClearOfPlans(params: {
  plan: FanoutRoutePlan
  otherPlans: FanoutRoutePlan[]
  srj: SimpleRouteJson
  allowSameNetMerges: boolean
  clearance: number
  blockingBusCounts?: Map<string, number>
}): boolean {
  const {
    plan,
    otherPlans,
    srj,
    allowSameNetMerges,
    clearance,
    blockingBusCounts,
  } = params
  for (const otherPlan of otherPlans) {
    if (
      allowSameNetMerges &&
      connectionsShareElectricalNet(
        srj,
        plan.connectionName,
        otherPlan.connectionName,
      )
    ) {
      continue
    }
    const plansShareSourcePort =
      (plan.sourcePoint.pcb_port_id &&
        plan.sourcePoint.pcb_port_id === otherPlan.sourcePoint.pcb_port_id) ||
      (plan.sourcePoint.pointId &&
        plan.sourcePoint.pointId === otherPlan.sourcePoint.pointId)
    if (plansShareSourcePort) continue
    const recordBlocker = (): void => {
      if (otherPlan.busId === plan.busId) return
      blockingBusCounts?.set(
        otherPlan.busId,
        (blockingBusCounts.get(otherPlan.busId) ?? 0) + 1,
      )
    }
    const planSegments = getPlanSegments(plan)
    const otherSegments = getPlanSegments(otherPlan)
    const planVias = getPlanVias(plan)
    const otherVias = getPlanVias(otherPlan)
    for (const segment of planSegments) {
      for (const otherSegment of otherSegments) {
        if (!segmentsAreClear(segment, otherSegment, clearance)) {
          recordBlocker()
          return false
        }
      }
      for (const otherVia of otherVias) {
        if (
          otherVia.spanLayers.includes(segment.layer) &&
          distancePointToSegment(otherVia.center, segment.start, segment.end) <
            otherVia.diameter / 2 + segment.width / 2 + clearance - 1e-9
        ) {
          recordBlocker()
          return false
        }
      }
    }
    for (const planVia of planVias) {
      for (const otherSegment of otherSegments) {
        if (
          planVia.spanLayers.includes(otherSegment.layer) &&
          distancePointToSegment(
            planVia.center,
            otherSegment.start,
            otherSegment.end,
          ) <
            planVia.diameter / 2 + otherSegment.width / 2 + clearance - 1e-9
        ) {
          recordBlocker()
          return false
        }
      }
      for (const otherVia of otherVias) {
        if (
          planVia.spanLayers.some((layer) =>
            otherVia.spanLayers.includes(layer),
          ) &&
          distance(planVia.center, otherVia.center) <
            (planVia.diameter + otherVia.diameter) / 2 + clearance - 1e-9
        ) {
          recordBlocker()
          return false
        }
      }
    }
  }
  return true
}

function planIsClear(params: {
  plan: FanoutRoutePlan
  otherPlans: FanoutRoutePlan[]
  staticClearanceCache?: RouteBusStaticClearanceCache
  blockingBusCounts?: Map<string, number>
  cacheKey: string
  srj: SimpleRouteJson
  sharedBoundary: Bounds
  clearance: number
  allowSameNetMerges: boolean
}): boolean {
  const {
    plan,
    otherPlans,
    staticClearanceCache,
    blockingBusCounts,
    cacheKey,
    srj,
    sharedBoundary,
    clearance,
    allowSameNetMerges,
  } = params
  let staticallyClear = staticClearanceCache?.get(cacheKey)
  if (staticallyClear === undefined) {
    staticallyClear = planIsStaticallyClear({
      plan,
      srj,
      sharedBoundary,
      clearance,
      allowSameNetMerges,
    })
    staticClearanceCache?.set(cacheKey, staticallyClear)
  }
  return (
    staticallyClear &&
    planIsClearOfPlans({
      plan,
      otherPlans,
      srj,
      allowSameNetMerges,
      clearance,
      blockingBusCounts,
    })
  )
}

/**
 * Validate a complete set of fanout plans against the source SRJ and against
 * one another. This is intentionally separate from route search so every
 * route-producing strategy can share the same final safety invariant.
 */
export function fanoutPlansAreClear(params: {
  plans: readonly FanoutRoutePlan[]
  srj: SimpleRouteJson
  sharedBoundary: Bounds
  clearance: number
  allowSameNetMerges?: boolean
}): boolean {
  const {
    plans,
    srj,
    sharedBoundary,
    clearance,
    allowSameNetMerges = false,
  } = params
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]!
    if (
      !planIsStaticallyClear({
        plan,
        srj,
        sharedBoundary,
        clearance,
        allowSameNetMerges,
      })
    ) {
      return false
    }
    if (
      !planIsClearOfPlans({
        plan,
        otherPlans: plans.filter((_, otherIndex) => otherIndex !== index),
        srj,
        allowSameNetMerges,
        clearance,
      })
    ) {
      return false
    }
  }
  return true
}

function routePlaneTerminatedBus(
  params: RouteBusParams,
): FanoutRoutePlan[] | null {
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
    staticClearanceCache,
    blockingBusCounts,
    allowSameNetMerges = false,
  } = params
  const sourceObstacle = bus.connections[0]?.sourceObstacle
  if (!sourceObstacle || bus.termination.type !== "plane") return null
  const sourceLayer = bus.connections[0]!.sourceLayer
  if (targetLayer === sourceLayer) return null

  const candidateDirections: FanoutDirection[] = [
    bus.direction,
    ...(["left", "right", "up", "down"] as const).filter(
      (direction) => direction !== bus.direction,
    ),
  ]
  for (const direction of candidateDirections) {
    const directionalBus =
      direction === bus.direction ? bus : { ...bus, direction }
    const directionalPadSize = isHorizontal(direction)
      ? sourceObstacle.width
      : sourceObstacle.height
    const pairChannelFitsVia =
      getDirectionalPitch(directionalBus) / 2 - directionalPadSize / 2 >=
      viaDiameter / 2 + clearance - 1e-9
    const viaHandednesses: readonly ViaHandedness[] = pairChannelFitsVia
      ? [0]
      : [1, -1]

    for (const viaHandedness of viaHandednesses) {
      for (const connectionOrder of getConnectionOrders(directionalBus)) {
        const candidatePlans: FanoutRoutePlan[] = []
        let orderIsClear = true
        for (const preparedConnection of connectionOrder) {
          const sourceTrack = getPerpendicularAxis(
            preparedConnection.sourcePoint,
            direction,
          )
          const basePlan = buildPlan({
            preparedConnection,
            bus: directionalBus,
            targetLayer,
            track: sourceTrack,
            exitAxis: getExitAxis(directionalBus),
            layerNames,
            traceWidth,
            viaDiameter,
            viaHoleDiameter,
            viaHandedness,
            interstitialEscape: !pairChannelFitsVia,
            spreadLaneIndex: 0,
            cornerExitLaneOffset: 0,
            cornerLocalChannelLaneOffset: 0,
            cornerBoundaryChannelLaneOffset: 0,
            clearance,
            terminateAtVia: true,
          })
          const endpointViaCandidates = getPlaneEndpointViaCandidates({
            preparedConnection,
            bus: directionalBus,
            viaDiameter,
            clearance,
          })
          const plansToTry = [
            ...endpointViaCandidates.map((viaPoint) =>
              addPlaneEndpointTerminal({
                plan: basePlan,
                preparedConnection,
                planeLayer: targetLayer,
                viaPoint,
                layerNames,
                traceWidth,
                viaDiameter,
                viaHoleDiameter,
              }),
            ),
            basePlan,
          ]
          const plan = plansToTry.find((candidatePlan, candidateIndex) =>
            planIsClear({
              plan: candidatePlan,
              otherPlans: [...acceptedPlans, ...candidatePlans],
              staticClearanceCache,
              blockingBusCounts,
              cacheKey: `plane:${bus.busId}:${targetLayer}:${direction}:${preparedConnection.connectionIndex}:${viaHandedness}:${candidateIndex}`,
              srj,
              sharedBoundary: bus.sharedBoundary,
              clearance,
              allowSameNetMerges,
            }),
          )
          if (!plan) {
            orderIsClear = false
            break
          }
          candidatePlans.push(plan)
        }
        if (orderIsClear) return candidatePlans
      }
    }
  }

  return null
}

export function routeBusAlternatives(
  params: RouteBusParams,
  maxAlternatives = 1,
): FanoutRoutePlan[][] {
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
    compactBusTracks,
    staticClearanceCache,
    blockingBusCounts,
    allowSameNetMerges = false,
  } = params
  if (!Number.isInteger(maxAlternatives) || maxAlternatives < 1) {
    throw new Error(
      `FanoutSolver: maxAlternatives must be a positive integer, received ${maxAlternatives}`,
    )
  }
  if (bus.termination.type === "plane") {
    const plan = routePlaneTerminatedBus(params)
    return plan ? [plan] : []
  }
  const exitAxis = getExitAxis(bus)
  const sourceObstacle = bus.connections[0]?.sourceObstacle
  if (!sourceObstacle) return [[]]
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
  const viaHandednesses: readonly ViaHandedness[] = targetUsesVia
    ? pairChannelFitsVia || outwardEdgeBus
      ? [0]
      : [1, -1]
    : [0]

  const alternatives: FanoutRoutePlan[][] = []
  const seenAlternativeKeys = new Set<string>()
  const cornerLaneOffsets = getCornerLaneOffsets(bus, acceptedPlans)

  const addAlternative = (plans: FanoutRoutePlan[]): void => {
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

  const searchConnectionOrder = (
    connectionOrder: PreparedConnection[],
    viaHandedness: ViaHandedness,
    connectionIndex: number,
    candidatePlans: FanoutRoutePlan[],
  ): void => {
    if (alternatives.length >= maxAlternatives) return
    if (connectionIndex >= connectionOrder.length) {
      addAlternative(candidatePlans)
      return
    }

    const preparedConnection = connectionOrder[connectionIndex]!
    const connectionRank = getConnectionRank(bus, preparedConnection)
    const preferredTracks = [
      getPreferredTrack({
        bus,
        connection: preparedConnection,
        traceWidth,
      }),
      getLegacyPreferredTrack({
        bus,
        connection: preparedConnection,
        targetUsesVia,
        interstitialEscape,
        compactBusTracks,
        traceWidth,
        viaDiameter,
        clearance,
      }),
    ].filter(
      (track, index, tracks) =>
        tracks.findIndex((candidate) => Math.abs(candidate - track) < 1e-9) ===
        index,
    )
    const trackCandidates = preferredTracks
      .flatMap((preferredTrack) =>
        getTrackCandidates({
          bus,
          connection: preparedConnection,
          preferredTrack,
          traceWidth,
          clearance,
        }),
      )
      .filter(
        (track, index, tracks) =>
          tracks.findIndex(
            (candidate) => Math.abs(candidate.value - track.value) < 1e-9,
          ) === index,
      )
    for (
      let trackIndex = 0;
      trackIndex < trackCandidates.length;
      trackIndex++
    ) {
      const track = trackCandidates[trackIndex]!
      const plan = buildPlan({
        preparedConnection,
        bus,
        targetLayer,
        track: track.value,
        exitAxis,
        layerNames,
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
        viaHandedness,
        interstitialEscape,
        spreadLaneIndex: Math.min(
          connectionRank,
          bus.connections.length - connectionRank - 1,
        ),
        cornerExitLaneOffset: cornerLaneOffsets.exit,
        cornerLocalChannelLaneOffset: cornerLaneOffsets.localChannel,
        cornerBoundaryChannelLaneOffset: cornerLaneOffsets.boundaryChannel,
        clearance,
        terminateAtVia: false,
      })
      if (
        !planIsClear({
          plan,
          otherPlans: [...acceptedPlans, ...candidatePlans],
          staticClearanceCache,
          blockingBusCounts,
          cacheKey: `boundary:${bus.busId}:${targetLayer}:${preparedConnection.connectionIndex}:${viaHandedness}:${trackIndex}:${bus.exitEdge ?? "legacy"}:${cornerLaneOffsets.exit}:${cornerLaneOffsets.localChannel}:${cornerLaneOffsets.boundaryChannel}`,
          srj,
          sharedBoundary: bus.sharedBoundary,
          clearance,
          allowSameNetMerges,
        })
      ) {
        continue
      }
      searchConnectionOrder(
        connectionOrder,
        viaHandedness,
        connectionIndex + 1,
        [...candidatePlans, plan],
      )
      if (alternatives.length >= maxAlternatives) return
      if (maxAlternatives === 1) return
    }
  }

  for (const viaHandedness of viaHandednesses) {
    for (const connectionOrder of getConnectionOrders(bus)) {
      searchConnectionOrder(connectionOrder, viaHandedness, 0, [])
      if (alternatives.length >= maxAlternatives) return alternatives
    }
  }

  return alternatives
}

export function routeBus(params: RouteBusParams): FanoutRoutePlan[] | null {
  return routeBusAlternatives(params, 1)[0] ?? null
}
