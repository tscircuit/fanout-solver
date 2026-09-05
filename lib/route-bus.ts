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
  circleFitsInsideObstacle,
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import { getDogboneSideVariants } from "./get-dogbone-side-variants"
import { getViaSpanLayers } from "./layer-names"
import { matchComponentDogboneViaSites } from "./match-component-dogbone-via-sites"
import { getBoundaryDogboneViaPoints } from "./get-boundary-dogbone-via-points"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "./net-identity"
import {
  type RouteViaMinimalWindingProgress,
  routeViaMinimalWindingAlternativesSteps,
  type ViaMinimalWindingReservedVia,
} from "./route-via-minimal-winding"
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
  allowBlindAndBuriedVias?: boolean
  allowSameNetMerges?: boolean
  staticClearanceCache?: RouteBusStaticClearanceCache
  blockingBusCounts?: Map<string, number>
  rejectedViaMinimalCandidates?: FanoutRoutePlan[][]
  stopAfterFirstRejectedViaMinimalCandidate?: boolean
  fixedViaPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
  reservedVias?: readonly ViaMinimalWindingReservedVia[]
  viaMinimalOnly?: boolean
  /** Permit a singleton or pair to move provisional vias near the boundary. */
  allowBoundarySideViaFallback?: boolean
  /** Reserve corner tuning space when selecting a boundary-side via. */
  preferCornerBoundaryVia?: boolean
  /** Retry blocked winding terminals ahead of already-routed terminals. */
  adaptiveWindingRouteOrder?: boolean
  /** Preserve pad-lattice channels in the automatic dense routing path. */
  alignWindingGridToPads?: boolean
  /** Bounds the final fixed-via winding fallback after ordered attempts. */
  fixedViaFallbackRouteOrderAttempts?: number
  /** Skip this many otherwise-clear plane escapes when enumerating alternatives. */
  planeCandidateSkipCount?: number
  /** Dense corner-band phase that preserves existing lane centers when leading lanes are prepended. */
  cornerBandTargetTrackOffset?: number
}

export interface RouteBusAlternativesProgress {
  phase: "via-minimal-winding"
  busId: string
  targetLayer: string
  winding: RouteViaMinimalWindingProgress
}

interface TrackCandidate {
  value: number
  kind: "corridor" | "gap" | "margin" | "preferred"
}

type ViaHandedness = -1 | 0 | 1

function allowsViaInPad(srj: SimpleRouteJson): boolean {
  return (
    (srj as SimpleRouteJson & { allowViaInPad?: boolean }).allowViaInPad ===
    true
  )
}

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
  return Boolean(
    bus.exitEdge &&
      bus.termination.type === "boundary" &&
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

function getWindingTargetOrders(params: {
  bus: PreparedBus
  boundaryDirection: FanoutDirection
  layerNames: readonly string[]
  targetLayer: string
}): {
  orders: PreparedConnection[][]
  legacyOrder: PreparedConnection[]
} {
  const { bus, boundaryDirection, layerNames, targetLayer } = params
  const getTargetLayer = (candidate: PreparedConnection): string =>
    candidate.exitTargetPoint?.layer ?? getPointLayer(candidate.targetPoint)
  const compareWithinLayer = (
    first: PreparedConnection,
    second: PreparedConnection,
  ): number => {
    const axisDifference =
      getPerpendicularAxis(
        first.exitTargetPoint ?? first.targetPoint,
        boundaryDirection,
      ) -
      getPerpendicularAxis(
        second.exitTargetPoint ?? second.targetPoint,
        boundaryDirection,
      )
    if (axisDifference !== 0) return axisDifference

    const firstStableId = getStableConnectionIdentity(first.connection)
    const secondStableId = getStableConnectionIdentity(second.connection)
    const stableIdentityDifference = firstStableId.localeCompare(secondStableId)
    if (stableIdentityDifference !== 0) return stableIdentityDifference

    return (
      first.connection.name.localeCompare(second.connection.name) ||
      first.connectionIndex - second.connectionIndex
    )
  }
  const legacyOrderedConnections = bus.connections.toSorted((first, second) => {
    const axisDifference =
      getPerpendicularAxis(
        first.exitTargetPoint ?? first.targetPoint,
        boundaryDirection,
      ) -
      getPerpendicularAxis(
        second.exitTargetPoint ?? second.targetPoint,
        boundaryDirection,
      )
    if (axisDifference !== 0) return axisDifference
    return (
      first.connection.name.localeCompare(second.connection.name) ||
      getStableConnectionIdentity(first.connection).localeCompare(
        getStableConnectionIdentity(second.connection),
      ) ||
      layerNames.indexOf(getTargetLayer(first)) -
        layerNames.indexOf(getTargetLayer(second)) ||
      first.connectionIndex - second.connectionIndex
    )
  })
  const connectionsByLayer = new Map<string, PreparedConnection[]>()
  for (const candidate of bus.connections) {
    const layer = getTargetLayer(candidate)
    const layerConnections = connectionsByLayer.get(layer) ?? []
    layerConnections.push(candidate)
    connectionsByLayer.set(layer, layerConnections)
  }
  const orderedLayers = [...connectionsByLayer.keys()].toSorted(
    (first, second) =>
      Number(second === targetLayer) - Number(first === targetLayer) ||
      layerNames.indexOf(first) - layerNames.indexOf(second) ||
      first.localeCompare(second),
  )
  const layerOrderByName = new Map(
    orderedLayers.map((layer, layerOrder) => [layer, layerOrder]),
  )
  const rankWithinLayerByConnectionIndex = new Map<number, number>()
  for (const layer of orderedLayers) {
    for (const [rank, candidate] of connectionsByLayer
      .get(layer)!
      .toSorted(compareWithinLayer)
      .entries()) {
      rankWithinLayerByConnectionIndex.set(candidate.connectionIndex, rank)
    }
  }
  // Winding targets define an order within each copper layer. Their absolute
  // offsets across different layers are not an ordering constraint: unrelated
  // buses can move those layer bands without changing this bus's topology.
  // Build a canonical interleave plus its adjacent linear extensions so a
  // via-minimal search can choose a locally routable merge without violating
  // any same-layer winding order.
  const canonicalOrderedConnections = bus.connections.toSorted(
    (first, second) =>
      (rankWithinLayerByConnectionIndex.get(first.connectionIndex) ?? 0) -
        (rankWithinLayerByConnectionIndex.get(second.connectionIndex) ?? 0) ||
      (layerOrderByName.get(getTargetLayer(first)) ?? 0) -
        (layerOrderByName.get(getTargetLayer(second)) ?? 0) ||
      compareWithinLayer(first, second),
  )
  const candidateOrders: PreparedConnection[][] = [canonicalOrderedConnections]
  for (let index = 0; index + 1 < canonicalOrderedConnections.length; index++) {
    const first = canonicalOrderedConnections[index]!
    const second = canonicalOrderedConnections[index + 1]!
    if (getTargetLayer(first) === getTargetLayer(second)) continue
    const adjacentExtension = [...canonicalOrderedConnections]
    adjacentExtension[index] = second
    adjacentExtension[index + 1] = first
    candidateOrders.push(adjacentExtension)
  }
  // Retain the coordinate-total-order behavior as a compatibility fallback,
  // but do not let sub-nanometer noise between unrelated layer bands choose
  // the primary topology.
  candidateOrders.push(legacyOrderedConnections)
  const seenOrders = new Set<string>()
  const orders = candidateOrders.filter((order) => {
    const key = order.map((candidate) => candidate.connectionIndex).join(",")
    if (seenOrders.has(key)) return false
    seenOrders.add(key)
    return true
  })
  return { orders, legacyOrder: legacyOrderedConnections }
}

function getWindingTargetRank(params: {
  bus: PreparedBus
  connection: PreparedConnection
  boundaryDirection: FanoutDirection
  layerNames: readonly string[]
  targetLayer: string
  windingOrderIndex?: number
}): { rank: number; connectionCount: number } {
  const { connection, windingOrderIndex = 0 } = params
  const { orders, legacyOrder } = getWindingTargetOrders(params)
  const orderedConnections =
    params.windingOrderIndex === undefined
      ? legacyOrder
      : (orders[windingOrderIndex] ?? orders[0] ?? legacyOrder)
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

export function getBoundaryTargetTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  boundaryDirection: FanoutDirection
}): number {
  const requestedTrack = getPerpendicularAxis(
    params.connection.exitTargetPoint ?? params.connection.targetPoint,
    params.boundaryDirection,
  )
  const boundaryMinimum = isHorizontal(params.boundaryDirection)
    ? params.bus.sharedBoundary.minY
    : params.bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(params.boundaryDirection)
    ? params.bus.sharedBoundary.maxY
    : params.bus.sharedBoundary.maxX
  return Math.max(boundaryMinimum, Math.min(boundaryMaximum, requestedTrack))
}

function getCornerTargetTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  cornerExitLaneOffset: number
  traceWidth: number
  viaDiameter: number
  clearance: number
  layerNames: readonly string[]
  targetLayer: string
  windingOrderIndex?: number
  cornerBandTargetTrackOffset?: number
}): number {
  const {
    bus,
    connection,
    cornerExitLaneOffset,
    traceWidth,
    viaDiameter,
    clearance,
    layerNames,
    targetLayer,
    windingOrderIndex,
    cornerBandTargetTrackOffset = 0,
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
    (boundaryMaximum - boundaryMinimum) * (side === "minimum" ? 0.25 : 0.75) +
    cornerBandTargetTrackOffset
  const windingTarget = busUsesCoordinatedWindingChannel(bus)
    ? getWindingTargetRank({
        bus,
        connection,
        boundaryDirection,
        layerNames,
        targetLayer,
        windingOrderIndex,
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

function chamferOrthogonalCorners(
  points: readonly Point2D[],
  requestedChamfer: number,
): Point2D[] {
  if (points.length < 3) return [...points]
  const output: Point2D[] = [points[0]!]
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!
    const current = points[index]!
    const next = points[index + 1]!
    const incoming = { x: current.x - previous.x, y: current.y - previous.y }
    const outgoing = { x: next.x - current.x, y: next.y - current.y }
    const incomingLength = Math.hypot(incoming.x, incoming.y)
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y)
    const incomingIsAxisAligned =
      Math.abs(incoming.x) <= 1e-9 || Math.abs(incoming.y) <= 1e-9
    const outgoingIsAxisAligned =
      Math.abs(outgoing.x) <= 1e-9 || Math.abs(outgoing.y) <= 1e-9
    const isOrthogonal =
      Math.abs(incoming.x * outgoing.x + incoming.y * outgoing.y) <= 1e-9
    if (
      incomingLength <= 1e-9 ||
      outgoingLength <= 1e-9 ||
      !incomingIsAxisAligned ||
      !outgoingIsAxisAligned ||
      !isOrthogonal
    ) {
      output.push(current)
      continue
    }
    const chamfer = Math.min(
      requestedChamfer,
      incomingLength / 3,
      outgoingLength / 3,
    )
    output.push({
      x: current.x - (incoming.x / incomingLength) * chamfer,
      y: current.y - (incoming.y / incomingLength) * chamfer,
    })
    output.push({
      x: current.x + (outgoing.x / outgoingLength) * chamfer,
      y: current.y + (outgoing.y / outgoingLength) * chamfer,
    })
  }
  output.push(points.at(-1)!)
  return output.filter(
    (point, index) => index === 0 || distance(point, output[index - 1]!) > 1e-9,
  )
}

function getStraightOr45ConnectorVariants(
  start: Point2D,
  end: Point2D,
): Point2D[][] {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const absoluteX = Math.abs(deltaX)
  const absoluteY = Math.abs(deltaY)
  if (
    absoluteX <= 1e-9 ||
    absoluteY <= 1e-9 ||
    Math.abs(absoluteX - absoluteY) <= 1e-9
  ) {
    return [[start, end]]
  }
  if (absoluteX > absoluteY) {
    return [
      [start, { x: start.x + Math.sign(deltaX) * absoluteY, y: end.y }, end],
      [start, { x: end.x - Math.sign(deltaX) * absoluteY, y: start.y }, end],
    ]
  }
  return [
    [start, { x: end.x, y: start.y + Math.sign(deltaY) * absoluteX }, end],
    [start, { x: start.x, y: end.y - Math.sign(deltaY) * absoluteX }, end],
  ]
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

function getInitialViaPoint(params: {
  preparedConnection: PreparedConnection
  bus: PreparedBus
  targetLayer: string
  traceWidth: number
  viaDiameter: number
  clearance: number
  viaHandedness: ViaHandedness
}): Point2D {
  const {
    preparedConnection,
    bus,
    targetLayer,
    traceWidth,
    viaDiameter,
    clearance,
    viaHandedness,
  } = params
  const sourcePoint = {
    x: preparedConnection.sourcePoint.x,
    y: preparedConnection.sourcePoint.y,
  }
  const targetUsesVia = targetLayer !== preparedConnection.sourceLayer
  const directionalPitch = getDirectionalPitch(bus)
  const perpendicularPitch = getPerpendicularPitch(bus)
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
    getAxis(sourcePoint, bus.direction) +
    directionSign(bus.direction) * initialEscapeDistance
  const viaPerpendicularAxis =
    getPerpendicularAxis(sourcePoint, bus.direction) +
    viaHandedness * perpendicularPitch * 0.5
  return makePoint(viaAxis, viaPerpendicularAxis, bus.direction)
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
  allowBlindAndBuriedVias: boolean
  initialViaPoint?: Point2D
  sourceEscapePath?: readonly Point2D[]
  cornerBandTargetTrackOffset?: number
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
    allowBlindAndBuriedVias,
    initialViaPoint,
    sourceEscapePath,
    cornerBandTargetTrackOffset,
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
  const requestedViaPoint = sourceEscapePath?.at(-1)
  const viaPoint =
    requestedViaPoint !== undefined
      ? { x: requestedViaPoint.x, y: requestedViaPoint.y }
      : initialViaPoint === undefined
        ? getInitialViaPoint({
            preparedConnection,
            bus,
            targetLayer,
            traceWidth,
            viaDiameter,
            clearance,
            viaHandedness,
          })
        : { x: initialViaPoint.x, y: initialViaPoint.y }
  const resolvedSourceEscapePath = sourceEscapePath
    ? sourceEscapePath.map((point) => ({ x: point.x, y: point.y }))
    : [sourcePoint, viaPoint]
  if (
    resolvedSourceEscapePath.length < 2 ||
    distance(resolvedSourceEscapePath[0]!, sourcePoint) > 1e-9 ||
    distance(resolvedSourceEscapePath.at(-1)!, viaPoint) > 1e-9
  ) {
    throw new Error(
      `FanoutSolver: source escape path for "${preparedConnection.connection.name}" must run from its source point to its via`,
    )
  }
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
          targetLayer,
          cornerBandTargetTrackOffset,
        })
      : usesLayeredWindingChannel
        ? getBoundaryTargetTrack({
            bus,
            connection: preparedConnection,
            boundaryDirection,
          })
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
  for (
    let pointIndex = 1;
    pointIndex < resolvedSourceEscapePath.length;
    pointIndex++
  ) {
    const previousPoint = resolvedSourceEscapePath[pointIndex - 1]!
    const point = resolvedSourceEscapePath[pointIndex]!
    appendSegment(
      segments,
      previousPoint,
      point,
      traceWidth,
      preparedConnection.sourceLayer,
    )
    if (distance(previousPoint, point) <= 1e-9) continue
    route.push({
      route_type: "wire",
      x: point.x,
      y: point.y,
      width: traceWidth,
      layer: preparedConnection.sourceLayer,
    })
  }

  let via: FanoutRoutePlan["via"]
  if (targetLayer !== preparedConnection.sourceLayer) {
    const spanLayers = getViaSpanLayers({
      fromLayer: preparedConnection.sourceLayer,
      toLayer: targetLayer,
      layerNames,
      allowBlindAndBuriedVias,
    })
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
        spanLayers: getViaSpanLayers({
          fromLayer,
          toLayer,
          layerNames,
          allowBlindAndBuriedVias,
        }),
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
    targetLayer,
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
  allowBlindAndBuriedVias: boolean
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
    allowBlindAndBuriedVias,
  } = params
  const targetPoint = {
    x: preparedConnection.targetPoint.x,
    y: preparedConnection.targetPoint.y,
  }
  const targetEndpointLayer = getPointLayer(preparedConnection.targetPoint)
  const spanLayers = getViaSpanLayers({
    fromLayer: planeLayer,
    toLayer: targetEndpointLayer,
    layerNames,
    allowBlindAndBuriedVias,
  })
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
    // A winding escape can turn more than once while leaving its own pad.
    if (
      segmentIndex >= 0 &&
      segmentIndex < (plan.sourceEscapeSegmentCount ?? 1) &&
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

function viaFitsInsidePlanSourcePad(
  plan: FanoutRoutePlan,
  via: NonNullable<FanoutRoutePlan["via"]>,
): boolean {
  return (
    distance(via.center, plan.sourcePoint) <= 1e-9 &&
    circleFitsInsideObstacle({
      center: via.center,
      diameter: via.diameter,
      obstacle: plan.sourceObstacle,
    })
  )
}

function planIsStaticallyClear(params: {
  plan: FanoutRoutePlan
  srj: SimpleRouteJson
  sharedBoundary: Bounds
  clearance: number
  allowBlindAndBuriedVias: boolean
  allowSameNetMerges: boolean
}): boolean {
  const {
    plan,
    srj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias,
    allowSameNetMerges,
  } = params
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
      if (
        allowsViaInPad(srj) &&
        obstacle === plan.sourceObstacle &&
        viaFitsInsidePlanSourcePad(plan, via)
      ) {
        continue
      }
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

  for (const traceCopper of getAllRoutedTraceCopper(
    srj,
    allowBlindAndBuriedVias,
  )) {
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

export function fanoutPlansAreMutuallyClear(params: {
  plans: readonly FanoutRoutePlan[]
  srj: SimpleRouteJson
  clearance: number
  allowSameNetMerges?: boolean
}): boolean {
  const { plans, srj, clearance, allowSameNetMerges = false } = params
  return plans.every((plan, index) =>
    planIsClearOfPlans({
      plan,
      otherPlans: plans.filter((_, otherIndex) => otherIndex !== index),
      srj,
      allowSameNetMerges,
      clearance,
    }),
  )
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
  allowBlindAndBuriedVias: boolean
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
    allowBlindAndBuriedVias,
    allowSameNetMerges,
  } = params
  let staticallyClear = staticClearanceCache?.get(cacheKey)
  if (staticallyClear === undefined) {
    staticallyClear = planIsStaticallyClear({
      plan,
      srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias,
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
  allowBlindAndBuriedVias?: boolean
  allowSameNetMerges?: boolean
}): boolean {
  const {
    plans,
    srj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias = true,
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
        allowBlindAndBuriedVias,
        allowSameNetMerges,
      })
    ) {
      return false
    }
    const otherPlans = plans.filter((_, otherIndex) => otherIndex !== index)
    if (
      !planIsClearOfPlans({
        plan,
        otherPlans,
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
  params: RouteBusParams & {
    collectAlternative?: (plan: FanoutRoutePlan) => boolean
  },
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
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
    fixedViaPointsByConnectionIndex,
    planeCandidateSkipCount = 0,
  } = params
  const sourceObstacle = bus.connections[0]?.sourceObstacle
  if (!sourceObstacle || bus.termination.type !== "plane") return null
  const sourceLayer = bus.connections[0]!.sourceLayer
  if (targetLayer === sourceLayer) return null
  let remainingPlaneCandidatesToSkip = planeCandidateSkipCount
  const selectClearPlanePlan = (
    plans: FanoutRoutePlan[],
    isClear: (plan: FanoutRoutePlan, index: number) => boolean,
  ): FanoutRoutePlan | undefined => {
    for (const [index, plan] of plans.entries()) {
      if (!isClear(plan, index)) continue
      if (remainingPlaneCandidatesToSkip > 0) {
        remainingPlaneCandidatesToSkip--
        continue
      }
      if (params.collectAlternative && !params.collectAlternative(plan))
        continue
      return plan
    }
    return undefined
  }

  if (fixedViaPointsByConnectionIndex) {
    const fixedPlans: FanoutRoutePlan[] = []
    for (const preparedConnection of bus.connections) {
      const fixedViaPoint = fixedViaPointsByConnectionIndex.get(
        preparedConnection.connectionIndex,
      )
      if (!fixedViaPoint) return null
      const sourcePoint = {
        x: preparedConnection.sourcePoint.x,
        y: preparedConnection.sourcePoint.y,
      }
      const basePlan = buildPlan({
        preparedConnection,
        bus,
        targetLayer,
        track: getPerpendicularAxis(sourcePoint, bus.direction),
        exitAxis: getExitAxis(bus),
        layerNames,
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
        viaHandedness: 0,
        interstitialEscape: false,
        spreadLaneIndex: 0,
        cornerExitLaneOffset: 0,
        cornerLocalChannelLaneOffset: 0,
        cornerBoundaryChannelLaneOffset: 0,
        clearance,
        terminateAtVia: true,
        allowBlindAndBuriedVias,
        initialViaPoint: fixedViaPoint,
        sourceEscapePath: [sourcePoint, fixedViaPoint],
      })
      const endpointViaCandidates = getPlaneEndpointViaCandidates({
        preparedConnection,
        bus,
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
            allowBlindAndBuriedVias,
          }),
        ),
        basePlan,
      ]
      const clearPlan = selectClearPlanePlan(
        plansToTry,
        (candidatePlan, candidateIndex) =>
          planIsClear({
            plan: candidatePlan,
            otherPlans: [...acceptedPlans, ...fixedPlans],
            staticClearanceCache,
            blockingBusCounts,
            cacheKey: `plane-fixed:${bus.busId}:${targetLayer}:${preparedConnection.connectionIndex}:${fixedViaPoint.x}:${fixedViaPoint.y}:${candidateIndex}`,
            srj,
            sharedBoundary: bus.sharedBoundary,
            clearance,
            allowBlindAndBuriedVias,
            allowSameNetMerges,
          }),
      )
      if (!clearPlan) return null
      fixedPlans.push(clearPlan)
    }
    return fixedPlans
  }

  if (
    allowsViaInPad(srj) &&
    bus.connections.length === 1 &&
    circleFitsInsideObstacle({
      center: bus.connections[0]!.sourcePoint,
      diameter: viaDiameter,
      obstacle: sourceObstacle,
    })
  ) {
    const preparedConnection = bus.connections[0]!
    const viaInPadPlan = buildPlan({
      preparedConnection,
      bus,
      targetLayer,
      track: getPerpendicularAxis(
        preparedConnection.sourcePoint,
        bus.direction,
      ),
      exitAxis: getExitAxis(bus),
      layerNames,
      traceWidth,
      viaDiameter,
      viaHoleDiameter,
      viaHandedness: 0,
      interstitialEscape: false,
      spreadLaneIndex: 0,
      cornerExitLaneOffset: 0,
      cornerLocalChannelLaneOffset: 0,
      cornerBoundaryChannelLaneOffset: 0,
      clearance,
      terminateAtVia: true,
      allowBlindAndBuriedVias,
      initialViaPoint: preparedConnection.sourcePoint,
    })
    const endpointViaCandidates = getPlaneEndpointViaCandidates({
      preparedConnection,
      bus,
      viaDiameter,
      clearance,
    })
    const plansToTry = [
      ...endpointViaCandidates.map((viaPoint) =>
        addPlaneEndpointTerminal({
          plan: viaInPadPlan,
          preparedConnection,
          planeLayer: targetLayer,
          viaPoint,
          layerNames,
          traceWidth,
          viaDiameter,
          viaHoleDiameter,
          allowBlindAndBuriedVias,
        }),
      ),
      viaInPadPlan,
    ]
    const clearPlan = selectClearPlanePlan(
      plansToTry,
      (candidatePlan, candidateIndex) =>
        planIsClear({
          plan: candidatePlan,
          otherPlans: acceptedPlans,
          staticClearanceCache,
          blockingBusCounts,
          cacheKey: `plane-via-in-pad:${bus.busId}:${targetLayer}:${candidateIndex}`,
          srj,
          sharedBoundary: bus.sharedBoundary,
          clearance,
          allowBlindAndBuriedVias,
          allowSameNetMerges,
        }),
    )
    if (clearPlan) return [clearPlan]
  }

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
          const adjacentViaPoint = getInitialViaPoint({
            preparedConnection,
            bus: directionalBus,
            targetLayer,
            traceWidth,
            viaDiameter,
            clearance,
            viaHandedness,
          })
          const directionPitch = getDirectionalPitch(directionalBus)
          const sign = directionSign(direction)
          const boundaryAxis = getExitAxis(directionalBus, direction)
          const availableTravel =
            sign * (boundaryAxis - getAxis(adjacentViaPoint, direction)) -
            (viaDiameter / 2 + clearance)
          const maximumEscapeSteps = Math.max(
            0,
            Math.floor(availableTravel / directionPitch),
          )
          const sourcePoint = {
            x: preparedConnection.sourcePoint.x,
            y: preparedConnection.sourcePoint.y,
          }
          const adjacentAxis = getAxis(adjacentViaPoint, direction)
          const adjacentPerpendicularAxis = getPerpendicularAxis(
            adjacentViaPoint,
            direction,
          )
          const perpendicularPitch = getPerpendicularPitch(directionalBus)
          const sourceEscapePaths: Point2D[][] = []
          const maximumCandidatePaths = 128
          for (
            let totalSteps = 0;
            totalSteps <= maximumEscapeSteps &&
            sourceEscapePaths.length < maximumCandidatePaths;
            totalSteps++
          ) {
            const straightViaPoint = makePoint(
              adjacentAxis + sign * totalSteps * directionPitch,
              adjacentPerpendicularAxis,
              direction,
            )
            if (totalSteps === 0) {
              sourceEscapePaths.push([sourcePoint, adjacentViaPoint])
            } else {
              for (const connector of getStraightOr45ConnectorVariants(
                sourcePoint,
                straightViaPoint,
              )) {
                sourceEscapePaths.push(connector)
                if (sourceEscapePaths.length >= maximumCandidatePaths) break
              }
              if (sourceEscapePaths.length < maximumCandidatePaths) {
                sourceEscapePaths.push([
                  sourcePoint,
                  adjacentViaPoint,
                  straightViaPoint,
                ])
              }
            }

            for (
              let lateralSteps = 1;
              lateralSteps <= Math.min(3, totalSteps - 1) &&
              sourceEscapePaths.length < maximumCandidatePaths;
              lateralSteps++
            ) {
              const outwardSteps = totalSteps - lateralSteps
              if (outwardSteps < 1 || outwardSteps > maximumEscapeSteps) {
                continue
              }
              for (const lateralSign of [-1, 1] as const) {
                const lateralAxis =
                  adjacentPerpendicularAxis +
                  lateralSign * lateralSteps * perpendicularPitch
                const lateralPoint = makePoint(
                  adjacentAxis,
                  lateralAxis,
                  direction,
                )
                const outwardPoint = makePoint(
                  adjacentAxis + sign * outwardSteps * directionPitch,
                  adjacentPerpendicularAxis,
                  direction,
                )
                const detourViaPoint = makePoint(
                  adjacentAxis + sign * outwardSteps * directionPitch,
                  lateralAxis,
                  direction,
                )
                const chamfer =
                  Math.min(directionPitch, perpendicularPitch) * 0.2
                for (const connector of getStraightOr45ConnectorVariants(
                  sourcePoint,
                  detourViaPoint,
                )) {
                  sourceEscapePaths.push(connector)
                  if (sourceEscapePaths.length >= maximumCandidatePaths) break
                }
                if (sourceEscapePaths.length >= maximumCandidatePaths) break
                sourceEscapePaths.push(
                  chamferOrthogonalCorners(
                    [
                      sourcePoint,
                      adjacentViaPoint,
                      lateralPoint,
                      detourViaPoint,
                    ],
                    chamfer,
                  ),
                  chamferOrthogonalCorners(
                    [
                      sourcePoint,
                      adjacentViaPoint,
                      outwardPoint,
                      detourViaPoint,
                    ],
                    chamfer,
                  ),
                )
                if (sourceEscapePaths.length >= maximumCandidatePaths) break
              }
            }
          }
          let plan: FanoutRoutePlan | undefined
          for (const [
            pathIndex,
            sourceEscapePath,
          ] of sourceEscapePaths.entries()) {
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
              allowBlindAndBuriedVias,
              sourceEscapePath,
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
                  allowBlindAndBuriedVias,
                }),
              ),
              basePlan,
            ]
            plan = selectClearPlanePlan(
              plansToTry,
              (candidatePlan, candidateIndex) =>
                planIsClear({
                  plan: candidatePlan,
                  otherPlans: [...acceptedPlans, ...candidatePlans],
                  staticClearanceCache,
                  blockingBusCounts,
                  cacheKey: `plane:${bus.busId}:${targetLayer}:${direction}:${preparedConnection.connectionIndex}:${viaHandedness}:${pathIndex}:${candidateIndex}`,
                  srj,
                  sharedBoundary: bus.sharedBoundary,
                  clearance,
                  allowBlindAndBuriedVias,
                  allowSameNetMerges,
                }),
            )
            if (plan) break
          }
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

export function* routeBusAlternativesSteps(
  params: RouteBusParams,
  maxAlternatives = 1,
  includeVisualization = false,
): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[][], void> {
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
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
    rejectedViaMinimalCandidates,
    stopAfterFirstRejectedViaMinimalCandidate = false,
    fixedViaPointsByConnectionIndex,
    reservedVias = [],
    viaMinimalOnly = false,
    allowBoundarySideViaFallback = false,
    preferCornerBoundaryVia = false,
    adaptiveWindingRouteOrder = false,
    alignWindingGridToPads = false,
    fixedViaFallbackRouteOrderAttempts = 24,
    cornerBandTargetTrackOffset,
  } = params
  if (!Number.isInteger(maxAlternatives) || maxAlternatives < 1) {
    throw new Error(
      `FanoutSolver: maxAlternatives must be a positive integer, received ${maxAlternatives}`,
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

  if (busUsesCoordinatedWindingChannel(bus) && bus.exitEdge) {
    const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
    const boundaryExitAxis = getExitAxis(bus, boundaryDirection)
    const cornerSide = getCornerSide(bus)
    const canUseViaInPadTerminals =
      allowsViaInPad(srj) &&
      bus.connections.every((preparedConnection) =>
        circleFitsInsideObstacle({
          center: preparedConnection.sourcePoint,
          diameter: viaDiameter,
          obstacle: preparedConnection.sourceObstacle,
        }),
      )
    type CoordinatedTerminalPattern = {
      label: string
      useViaInPad: boolean
      getViaHandedness: (
        preparedConnection: PreparedConnection,
      ) => ViaHandedness
      getViaPoint?: (preparedConnection: PreparedConnection) => Point2D
      maximumRouteOrderAttempts?: number
      windingOrderIndex?: number
      preferTargetDirectedLaneBias?: boolean
      localDogboneRepair?: boolean
    }
    const maximumThroughAllRouteOrderAttempts = 24
    const windingTargetOrderCount = cornerSide
      ? getWindingTargetOrders({
          bus,
          boundaryDirection,
          layerNames,
          targetLayer,
        }).orders.length
      : 1
    const uniformDogboneTerminalPatterns: CoordinatedTerminalPattern[] =
      viaHandednesses.map((viaHandedness) => ({
        label: `uniform-${viaHandedness}`,
        useViaInPad: false,
        getViaHandedness: () => viaHandedness,
        maximumRouteOrderAttempts: allowBlindAndBuriedVias
          ? undefined
          : maximumThroughAllRouteOrderAttempts,
      }))
    const connectionsBySourceTrack = bus.connections.toSorted(
      (first, second) =>
        getPerpendicularAxis(first.sourcePoint, bus.direction) -
          getPerpendicularAxis(second.sourcePoint, bus.direction) ||
        getAxis(first.sourcePoint, bus.direction) -
          getAxis(second.sourcePoint, bus.direction) ||
        first.connectionIndex - second.connectionIndex,
    )
    const sourceTrackRankByConnectionIndex = new Map(
      connectionsBySourceTrack.map((connection, rank) => [
        connection.connectionIndex,
        rank,
      ]),
    )
    const getTowardMedianHandedness = (rank: number): ViaHandedness =>
      rank < connectionsBySourceTrack.length / 2 ? 1 : -1
    const middleRank = Math.floor(connectionsBySourceTrack.length / 2)
    const singleFlipRanks = [
      0,
      1,
      middleRank,
      middleRank + 1,
      ...connectionsBySourceTrack.map((_, rank) => rank),
    ].filter(
      (rank, index, ranks) =>
        rank >= 0 &&
        rank < connectionsBySourceTrack.length &&
        ranks.indexOf(rank) === index,
    )
    const towardMedianFlipRankSets = [
      [middleRank],
      [middleRank + 1],
      [0],
      [1],
      [0, middleRank + 1],
      [1, middleRank],
      [0, middleRank],
      [1, middleRank + 1],
      [0, 1],
      [middleRank, middleRank + 1],
      ...singleFlipRanks.map((rank) => [rank]),
    ]
      .map((ranks) =>
        ranks
          .filter((rank) => rank >= 0 && rank < connectionsBySourceTrack.length)
          .toSorted((first, second) => first - second),
      )
      .filter(
        (ranks, index, rankSets) =>
          ranks.length > 0 &&
          rankSets.findIndex(
            (candidate) => candidate.join(",") === ranks.join(","),
          ) === index,
      )
    const mixedDogboneTerminalPatterns: CoordinatedTerminalPattern[] =
      !allowBlindAndBuriedVias &&
      (reservedVias.length > 0 ||
        acceptedPlans.some((plan) => plan.termination.type === "plane")) &&
      viaHandednesses.includes(-1) &&
      viaHandednesses.includes(1)
        ? [
            {
              label: "toward-source-median",
              useViaInPad: false,
              maximumRouteOrderAttempts: maximumThroughAllRouteOrderAttempts,
              getViaHandedness: (connection) =>
                getTowardMedianHandedness(
                  sourceTrackRankByConnectionIndex.get(
                    connection.connectionIndex,
                  ) ?? 0,
                ),
            },
            ...towardMedianFlipRankSets.slice(0, 12).map((flippedRanks) => ({
              label: `toward-source-median-with-ranks-${flippedRanks.join("-")}-flipped`,
              useViaInPad: false,
              maximumRouteOrderAttempts: 6,
              getViaHandedness: (connection: PreparedConnection) => {
                const rank =
                  sourceTrackRankByConnectionIndex.get(
                    connection.connectionIndex,
                  ) ?? 0
                const towardMedian = getTowardMedianHandedness(rank)
                return flippedRanks.includes(rank)
                  ? (-towardMedian as ViaHandedness)
                  : towardMedian
              },
            })),
            {
              label: "alternating-source-grid-a",
              useViaInPad: false,
              maximumRouteOrderAttempts: 3,
              getViaHandedness: (connection) =>
                (sourceTrackRankByConnectionIndex.get(
                  connection.connectionIndex,
                ) ?? 0) %
                  2 ===
                0
                  ? -1
                  : 1,
            },
            {
              label: "alternating-source-grid-b",
              useViaInPad: false,
              maximumRouteOrderAttempts: 3,
              getViaHandedness: (connection) =>
                (sourceTrackRankByConnectionIndex.get(
                  connection.connectionIndex,
                ) ?? 0) %
                  2 ===
                0
                  ? 1
                  : -1,
            },
            {
              label: "away-from-source-median",
              useViaInPad: false,
              maximumRouteOrderAttempts: maximumThroughAllRouteOrderAttempts,
              getViaHandedness: (connection) =>
                (sourceTrackRankByConnectionIndex.get(
                  connection.connectionIndex,
                ) ?? 0) <
                connectionsBySourceTrack.length / 2
                  ? -1
                  : 1,
            },
          ]
        : []
    const viaInPadTerminalPattern = {
      label: "via-in-pad",
      useViaInPad: true,
      getViaHandedness: () => 0 as const,
    }
    const coordinatedViaPoints =
      fixedViaPointsByConnectionIndex ??
      (!allowBlindAndBuriedVias &&
      bus.connections.length >= 8 &&
      reservedVias.length === 0
        ? matchComponentDogboneViaSites([bus], {
            viaDiameter,
            viaHoleDiameter,
            traceWidth,
            clearance,
            additionalObstacles: srj.obstacles,
            blockingSegments: acceptedPlans.flatMap((plan) =>
              getPlanSegments(plan).map((segment) => ({
                connectionIndex: plan.connectionIndex,
                segment,
              })),
            ),
            blockingVias: acceptedPlans.flatMap((plan) =>
              getPlanVias(plan).map((via) => ({
                connectionIndex: plan.connectionIndex,
                ...via.center,
                center: via.center,
                diameter: via.diameter,
                spanLayers: via.spanLayers,
              })),
            ),
          })
        : null)
    const fixedViaTerminalPatterns: CoordinatedTerminalPattern[] =
      coordinatedViaPoints
        ? [
            ...Array.from(
              { length: windingTargetOrderCount },
              (_, windingOrderIndex) => ({
                label: `component-matched-vias-winding-${windingOrderIndex}`,
                useViaInPad: false,
                getViaHandedness: () => 0 as const,
                getViaPoint: (connection: PreparedConnection) =>
                  coordinatedViaPoints.get(connection.connectionIndex)!,
                maximumRouteOrderAttempts: 1,
                windingOrderIndex,
                preferTargetDirectedLaneBias: true,
              }),
            ),
            {
              label: "component-matched-vias-fallback",
              useViaInPad: false,
              getViaHandedness: () => 0,
              getViaPoint: (connection) =>
                coordinatedViaPoints.get(connection.connectionIndex)!,
              // Preserve the existing bounded search after every inexpensive
              // layer-interleave candidate has had one deterministic attempt.
              maximumRouteOrderAttempts: fixedViaFallbackRouteOrderAttempts,
              windingOrderIndex: 0,
              preferTargetDirectedLaneBias: true,
            },
          ]
        : []
    const planeTerminationsAlreadyOccupyTheFanout = acceptedPlans.some(
      (plan) => plan.termination.type === "plane",
    )
    const acceptedBoundaryPlansExist = acceptedPlans.some(
      (plan) => plan.termination.type === "boundary",
    )
    const dogboneTerminalPatterns =
      acceptedBoundaryPlansExist && !allowBlindAndBuriedVias
        ? [...mixedDogboneTerminalPatterns, ...uniformDogboneTerminalPatterns]
        : [...uniformDogboneTerminalPatterns, ...mixedDogboneTerminalPatterns]
    const unreservedTerminalPatterns: CoordinatedTerminalPattern[] =
      canUseViaInPadTerminals
        ? planeTerminationsAlreadyOccupyTheFanout
          ? [viaInPadTerminalPattern, ...dogboneTerminalPatterns]
          : [...dogboneTerminalPatterns, viaInPadTerminalPattern]
        : dogboneTerminalPatterns
    // Automatically matched sites are candidates, not caller reservations.
    // Keep the ordinary dogbone patterns available before adding crossover
    // vias when that first site assignment cannot route the complete bus.
    const terminalPatterns: CoordinatedTerminalPattern[] =
      fixedViaPointsByConnectionIndex
        ? fixedViaTerminalPatterns
        : [...fixedViaTerminalPatterns, ...unreservedTerminalPatterns]
    if (
      !fixedViaPointsByConnectionIndex &&
      !allowBlindAndBuriedVias &&
      bus.connections.length > 1 &&
      bus.connections.every(
        (connection) => connection.sourceLayer !== targetLayer,
      ) &&
      viaHandednesses.includes(-1) &&
      viaHandednesses.includes(1)
    ) {
      // Keep the existing successful routes unchanged. Only after those site
      // assignments fail, try local inward dogbones that reopen a channel
      // closed by one or two pads in the same source row.
      const variants = getDogboneSideVariants(bus.connections, bus.direction)
      for (const handedness of viaHandednesses) {
        for (const flippedIndices of variants) {
          terminalPatterns.push({
            label: `local-dogbone-repair-${handedness}-${flippedIndices.join("-")}`,
            useViaInPad: false,
            getViaHandedness: () => handedness,
            maximumRouteOrderAttempts: 6,
            localDogboneRepair: true,
            getViaPoint: (connection) => {
              const point = getInitialViaPoint({
                preparedConnection: connection,
                bus,
                targetLayer,
                traceWidth,
                viaDiameter,
                clearance,
                viaHandedness: handedness,
              })
              if (!flippedIndices.includes(connection.connectionIndex))
                return point
              return bus.direction === "up" || bus.direction === "down"
                ? { x: point.x, y: 2 * connection.sourcePoint.y - point.y }
                : { x: 2 * connection.sourcePoint.x - point.x, y: point.y }
            },
          })
        }
      }
    }
    const seenTerminalSignatures = new Set<string>()
    for (const terminalPattern of terminalPatterns) {
      const terminals = bus.connections.map((preparedConnection) => {
        const viaHandedness =
          terminalPattern.getViaHandedness(preparedConnection)
        const boundaryTrack = cornerSide
          ? getCornerTargetTrack({
              bus,
              connection: preparedConnection,
              cornerExitLaneOffset: cornerLaneOffsets.exit,
              traceWidth,
              viaDiameter,
              clearance,
              layerNames,
              targetLayer,
              windingOrderIndex: terminalPattern.windingOrderIndex,
              cornerBandTargetTrackOffset,
            })
          : getBoundaryTargetTrack({
              bus,
              connection: preparedConnection,
              boundaryDirection,
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
          exitPoint: makePoint(
            boundaryExitAxis,
            boundaryTrack,
            boundaryDirection,
          ),
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
        )}:${terminalPattern.maximumRouteOrderAttempts ?? "all"}:${gridStepDivisor}:${alignGridToPads}:${Boolean(terminalPattern.localDogboneRepair)}`
      if (seenTerminalSignatures.has(terminalSignature)) continue
      seenTerminalSignatures.add(terminalSignature)
      const windingSteps = routeViaMinimalWindingAlternativesSteps(
        {
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
          gridStepDivisor,
          preferTargetDirectedLaneBias:
            terminalPattern.preferTargetDirectedLaneBias,
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
              return alternatives
            }
          }
          continue
        }
        addAlternative(viaMinimalPlans)
        if (alternatives.length >= maxAlternatives) return alternatives
      }
    }
  }

  // A through-via does not have to sit next to the source pad. A narrow bus
  // embedded in another bus's source field can have every local dogbone site
  // occupied while still having a clear source-layer escape. A pair first
  // relocates its two vias just outside the nearest package edge; a singleton
  // retains the boundary-side-via fallback. Both forms preserve one via per
  // signal without weakening any clearance rule.
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
            bus,
            connection: preparedConnection,
            boundaryDirection,
          }),
    )
    const finalExitPoints = finalTracks.map((track) =>
      makePoint(boundaryExitAxis, track, boundaryDirection),
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
    const insetStep = Math.max(
      viaDiameter / 2 + clearance,
      Math.min(bus.pitchX, bus.pitchY) / 2,
    )
    const cornerSide = preferCornerBoundaryVia ? getCornerSide(bus) : undefined
    const boundaryViaCandidates = [1, 2, 3, 4, 5].flatMap((multiple) => {
      const inset = multiple * insetStep
      const straight = finalTracks.map((finalTrack) =>
        makePoint(
          boundaryExitAxis - directionSign(boundaryDirection) * inset,
          finalTrack,
          boundaryDirection,
        ),
      )
      if (!cornerSide) return [straight]
      // Approach corner exits diagonally to leave the adjacent pair's tuning
      // lane free of the through-via barrel. Retain the straight fallback.
      return [
        finalTracks.map((finalTrack) =>
          makePoint(
            boundaryExitAxis - directionSign(boundaryDirection) * inset,
            finalTrack + (cornerSide === "maximum" ? inset : -inset),
            boundaryDirection,
          ),
        ),
        straight,
      ]
    })
    const sourceCenter = {
      x:
        bus.connections.reduce(
          (sum, connection) => sum + connection.sourcePoint.x,
          0,
        ) / bus.connections.length,
      y:
        bus.connections.reduce(
          (sum, connection) => sum + connection.sourcePoint.y,
          0,
        ) / bus.connections.length,
    }
    const directions = [
      { x: -1, y: 0, distance: sourceCenter.x - Math.min(...bus.xCoordinates) },
      { x: 1, y: 0, distance: Math.max(...bus.xCoordinates) - sourceCenter.x },
      { x: 0, y: -1, distance: sourceCenter.y - Math.min(...bus.yCoordinates) },
      { x: 0, y: 1, distance: Math.max(...bus.yCoordinates) - sourceCenter.y },
    ].toSorted((first, second) => first.distance - second.distance)
    const displacedViaCandidates =
      bus.connections.length === 2
        ? directions.flatMap((direction) =>
            [3].map((multiple) =>
              bus.connections.map((connection) => {
                const original = fixedViaPointsByConnectionIndex.get(
                  connection.connectionIndex,
                )!
                return {
                  x: original.x + direction.x * multiple * bus.pitchX,
                  y: original.y + direction.y * multiple * bus.pitchY,
                }
              }),
            ),
          )
        : []
    const viaCandidates = [
      ...displacedViaCandidates.map((points) => ({
        points,
        boundarySide: false,
      })),
      ...boundaryViaCandidates.map((points) => ({
        points,
        boundarySide: true,
      })),
    ]
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
          reservedVias:
            bus.connections.length > 1
              ? [...reservedVias, ...boundaryVias]
              : reservedVias,
          gridStepDivisor: 2,
          allowSourceLayerRouting: true,
          alignGridToPads: true,
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
            gridStepDivisor: 2,
            alignGridToPads: true,
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
            ...(preferCornerBoundaryVia || bus.connections.length > 1
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
        addAlternative(plans)
        return alternatives
      }
    }
  }

  if (viaMinimalOnly) return alternatives

  const vacantViaPointsByConnection = new Map<PreparedConnection, Point2D[]>()
  const searchConnectionOrder = ({
    connectionOrder,
    viaHandedness,
    connectionIndex,
    candidatePlans,
    includeVacantSites,
  }: {
    connectionOrder: PreparedConnection[]
    viaHandedness: ViaHandedness
    connectionIndex: number
    candidatePlans: FanoutRoutePlan[]
    includeVacantSites: boolean
  }): void => {
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
    const initialViaPoints = includeVacantSites
      ? [undefined, ...vacantViaPointsByConnection.get(preparedConnection)!]
      : [undefined]
    for (const initialViaPoint of initialViaPoints) {
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
          allowBlindAndBuriedVias,
          cornerBandTargetTrackOffset,
          initialViaPoint,
        })
        if (
          !planIsClear({
            plan,
            otherPlans: [...acceptedPlans, ...candidatePlans],
            staticClearanceCache,
            blockingBusCounts,
            cacheKey: `boundary:${bus.busId}:${targetLayer}:${preparedConnection.connectionIndex}:${viaHandedness}:${trackIndex}:${bus.exitEdge ?? "legacy"}:${cornerLaneOffsets.exit}:${cornerLaneOffsets.localChannel}:${cornerLaneOffsets.boundaryChannel}:${cornerBandTargetTrackOffset ?? 0}:${initialViaPoint ? `${initialViaPoint.x},${initialViaPoint.y}` : "default"}`,
            srj,
            sharedBoundary: bus.sharedBoundary,
            clearance,
            allowBlindAndBuriedVias,
            allowSameNetMerges,
          })
        ) {
          continue
        }
        searchConnectionOrder({
          connectionOrder,
          viaHandedness,
          connectionIndex: connectionIndex + 1,
          candidatePlans: [...candidatePlans, plan],
          includeVacantSites,
        })
        if (alternatives.length >= maxAlternatives) return
        if (maxAlternatives === 1) return
      }
    }
  }

  // Preserve the established handedness/order search before extending it with
  // sparse-grid dogbones. A new site must still pass the complete plan DRC.
  for (const includeVacantSites of [false, true]) {
    if (includeVacantSites) {
      if (!targetUsesVia) return alternatives
      for (const preparedConnection of bus.connections) {
        vacantViaPointsByConnection.set(preparedConnection, [
          ...getBoundaryDogboneViaPoints({
            bus,
            preparedConnection,
            targetLayer,
            rules: {
              viaDiameter,
              viaHoleDiameter,
              traceWidth,
              clearance,
              additionalObstacles: srj.obstacles,
            },
          }),
        ])
      }
      if (
        ![...vacantViaPointsByConnection.values()].some(
          (points) => points.length > 0,
        )
      ) {
        return alternatives
      }
    }
    for (const viaHandedness of viaHandednesses) {
      for (const connectionOrder of getConnectionOrders(bus)) {
        searchConnectionOrder({
          connectionOrder,
          viaHandedness,
          connectionIndex: 0,
          candidatePlans: [],
          includeVacantSites,
        })
        if (alternatives.length >= maxAlternatives) return alternatives
      }
    }
  }

  return alternatives
}

export function routeBusAlternatives(
  params: RouteBusParams,
  maxAlternatives = 1,
): FanoutRoutePlan[][] {
  const steps = routeBusAlternativesSteps(params, maxAlternatives)
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

export function routeBus(params: RouteBusParams): FanoutRoutePlan[] | null {
  return routeBusAlternatives(params, 1)[0] ?? null
}
