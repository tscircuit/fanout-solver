import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import { getLayerSpan } from "./layer-names"
import type {
  FanoutDirection,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "./types"

interface RouteBusParams {
  srj: SimpleRouteJson
  bus: PreparedBus
  targetLayer: string
  acceptedPlans: FanoutRoutePlan[]
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  breakoutMargin: number
}

interface TrackCandidate {
  value: number
  kind: "corridor" | "gap" | "margin"
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

function makePoint(
  axis: number,
  perpendicularAxis: number,
  direction: FanoutDirection,
): Point2D {
  return isHorizontal(direction)
    ? { x: axis, y: perpendicularAxis }
    : { x: perpendicularAxis, y: axis }
}

function getExitAxis(bus: PreparedBus, breakoutMargin: number): number {
  switch (bus.direction) {
    case "right":
      return bus.sharedBoundary.maxX + breakoutMargin
    case "left":
      return bus.sharedBoundary.minX - breakoutMargin
    case "up":
      return bus.sharedBoundary.maxY + breakoutMargin
    case "down":
      return bus.sharedBoundary.minY - breakoutMargin
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
  interstitialEscape: boolean
  traceWidth: number
  viaDiameter: number
  clearance: number
}): number {
  const {
    bus,
    connection,
    interstitialEscape,
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
  if (!interstitialEscape) return sourceTrack

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
  clearance: number
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
    clearance,
  } = params
  const sourcePoint = {
    x: preparedConnection.sourcePoint.x,
    y: preparedConnection.sourcePoint.y,
  }
  const sign = directionSign(bus.direction)
  const directionalPitch = getDirectionalPitch(bus)
  const perpendicularPitch = getPerpendicularPitch(bus)
  const viaAxis =
    getAxis(sourcePoint, bus.direction) + sign * directionalPitch * 0.5
  const sourcePerpendicularAxis = getPerpendicularAxis(
    sourcePoint,
    bus.direction,
  )
  const viaPerpendicularAxis =
    sourcePerpendicularAxis + viaHandedness * perpendicularPitch * 0.5
  const viaPoint = makePoint(viaAxis, viaPerpendicularAxis, bus.direction)
  const useNestedSpread = interstitialEscape
  const spreadLaneDistance =
    viaDiameter / 2 +
    traceWidth / 2 +
    clearance +
    1e-3 +
    spreadLaneIndex * (traceWidth + clearance)
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
  const exitPoint = makePoint(exitAxis, track, bus.direction)
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

  const targetLayerPoints = useNestedSpread
    ? chamferOrthogonalPolyline(
        [viaPoint, spreadPoint, doglegPoint, exitPoint],
        Math.max(traceWidth + clearance, traceWidth * 2),
      )
    : [viaPoint, doglegPoint, exitPoint]
  for (let index = 1; index < targetLayerPoints.length; index++) {
    const previousPoint = targetLayerPoints[index - 1]!
    const nextPoint = targetLayerPoints[index]!
    appendSegment(segments, previousPoint, nextPoint, traceWidth, targetLayer)
    route.push({
      route_type: "wire",
      x: nextPoint.x,
      y: nextPoint.y,
      width: traceWidth,
      layer: targetLayer,
    })
  }

  return {
    busId: bus.busId,
    connectionName: preparedConnection.connection.name,
    connectionIndex: preparedConnection.connectionIndex,
    sourcePointIndex: preparedConnection.sourcePointIndex,
    sourcePoint: preparedConnection.sourcePoint,
    sourceObstacle: preparedConnection.sourceObstacle,
    sourceLayer: preparedConnection.sourceLayer,
    targetLayer,
    direction: bus.direction,
    exitPoint,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: `fanout:${preparedConnection.connection.name}`,
      connection_name: preparedConnection.connection.name,
      connectsTo: [
        preparedConnection.connection.name,
        ...(preparedConnection.sourcePoint.pointId
          ? [preparedConnection.sourcePoint.pointId]
          : []),
        ...(preparedConnection.sourcePoint.pcb_port_id
          ? [preparedConnection.sourcePoint.pcb_port_id]
          : []),
      ],
      route,
    },
    segments,
    via,
    length: segments.reduce(
      (total, segment) => total + distance(segment.start, segment.end),
      0,
    ),
  }
}

function segmentIsClearOfObstacles(params: {
  segment: RoutedSegment
  plan: FanoutRoutePlan
  segmentIndex: number
  obstacles: Obstacle[]
  clearance: number
}): boolean {
  const { segment, plan, segmentIndex, obstacles, clearance } = params
  for (const obstacle of obstacles) {
    if (!obstacle.layers.includes(segment.layer)) continue
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

function planIsClear(params: {
  plan: FanoutRoutePlan
  otherPlans: FanoutRoutePlan[]
  srj: SimpleRouteJson
  clearance: number
}): boolean {
  const { plan, otherPlans, srj, clearance } = params
  if (
    !pointIsInsideBounds(plan.exitPoint, srj.bounds) ||
    plan.segments.some(
      (segment) =>
        !pointIsInsideBounds(segment.start, srj.bounds) ||
        !pointIsInsideBounds(segment.end, srj.bounds),
    )
  ) {
    return false
  }
  for (let index = 0; index < plan.segments.length; index++) {
    if (
      !segmentIsClearOfObstacles({
        segment: plan.segments[index]!,
        plan,
        segmentIndex: index,
        obstacles: srj.obstacles,
        clearance,
      })
    ) {
      return false
    }
  }
  if (plan.via) {
    for (const obstacle of srj.obstacles) {
      if (
        !obstacle.layers.some((layer) => plan.via!.spanLayers.includes(layer))
      ) {
        continue
      }
      if (
        distancePointToObstacle(plan.via.center, obstacle) <
        plan.via.diameter / 2 + clearance - 1e-9
      ) {
        return false
      }
    }
  }

  for (const otherPlan of otherPlans) {
    for (const segment of plan.segments) {
      for (const otherSegment of otherPlan.segments) {
        if (!segmentsAreClear(segment, otherSegment, clearance)) return false
      }
      if (
        otherPlan.via?.spanLayers.includes(segment.layer) &&
        distancePointToSegment(
          otherPlan.via.center,
          segment.start,
          segment.end,
        ) <
          otherPlan.via.diameter / 2 + segment.width / 2 + clearance - 1e-9
      ) {
        return false
      }
    }
    if (plan.via) {
      for (const otherSegment of otherPlan.segments) {
        if (
          plan.via.spanLayers.includes(otherSegment.layer) &&
          distancePointToSegment(
            plan.via.center,
            otherSegment.start,
            otherSegment.end,
          ) <
            plan.via.diameter / 2 + otherSegment.width / 2 + clearance - 1e-9
        ) {
          return false
        }
      }
      if (
        otherPlan.via &&
        plan.via.spanLayers.some((layer) =>
          otherPlan.via!.spanLayers.includes(layer),
        ) &&
        distance(plan.via.center, otherPlan.via.center) <
          (plan.via.diameter + otherPlan.via.diameter) / 2 + clearance - 1e-9
      ) {
        return false
      }
    }
  }
  return true
}

export function routeBus(params: RouteBusParams): FanoutRoutePlan[] | null {
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
    breakoutMargin,
  } = params
  const exitAxis = getExitAxis(bus, breakoutMargin)
  const sourceObstacle = bus.connections[0]?.sourceObstacle
  if (!sourceObstacle) return []
  const directionalPadSize = isHorizontal(bus.direction)
    ? sourceObstacle.width
    : sourceObstacle.height
  const sourceLayer = bus.connections[0]!.sourceLayer
  const targetUsesVia = targetLayer !== sourceLayer
  const pairChannelFitsVia =
    getDirectionalPitch(bus) / 2 - directionalPadSize / 2 >=
    viaDiameter / 2 + clearance - 1e-9
  const interstitialEscape = targetUsesVia && !pairChannelFitsVia
  const viaHandednesses: readonly ViaHandedness[] = targetUsesVia
    ? pairChannelFitsVia
      ? [0]
      : [1, -1]
    : [0]

  for (const viaHandedness of viaHandednesses) {
    for (const connectionOrder of getConnectionOrders(bus)) {
      const candidatePlans: FanoutRoutePlan[] = []
      let orderIsClear = true
      for (const preparedConnection of connectionOrder) {
        let acceptedPlan: FanoutRoutePlan | null = null
        for (const track of getTrackCandidates({
          bus,
          connection: preparedConnection,
          preferredTrack: getPreferredTrack({
            bus,
            connection: preparedConnection,
            interstitialEscape,
            traceWidth,
            viaDiameter,
            clearance,
          }),
          traceWidth,
          clearance,
        })) {
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
              getConnectionRank(bus, preparedConnection),
              bus.connections.length -
                getConnectionRank(bus, preparedConnection) -
                1,
            ),
            clearance,
          })
          if (
            planIsClear({
              plan,
              otherPlans: [...acceptedPlans, ...candidatePlans],
              srj,
              clearance,
            })
          ) {
            acceptedPlan = plan
            break
          }
        }
        if (!acceptedPlan) {
          orderIsClear = false
          break
        }
        candidatePlans.push(acceptedPlan)
      }
      if (orderIsClear) return candidatePlans
    }
  }

  return null
}
