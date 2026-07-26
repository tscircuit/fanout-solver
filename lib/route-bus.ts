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
  traceWidth: number
  clearance: number
}): TrackCandidate[] {
  const { bus, connection, traceWidth, clearance } = params
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
  const perpendicularPitch = isHorizontal(bus.direction)
    ? bus.pitchY
    : bus.pitchX
  const maximumJog = perpendicularPitch * 2
  const ladderMinimum = Math.max(
    boundaryMinimum,
    coordinates[0]! - obstacleHalfSize - maximumJog,
  )
  const ladderMaximum = Math.min(
    boundaryMaximum,
    coordinates.at(-1)! + obstacleHalfSize + maximumJog,
  )
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
        Math.abs(a.value - sourceTrack) -
        Math.abs(b.value - sourceTrack) -
        (Math.abs(a.value - componentCenter) -
          Math.abs(b.value - componentCenter)) *
          1e-3,
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
  } = params
  const sourcePoint = {
    x: preparedConnection.sourcePoint.x,
    y: preparedConnection.sourcePoint.y,
  }
  const sign = directionSign(bus.direction)
  const directionalPitch = getDirectionalPitch(bus)
  const viaAxis =
    getAxis(sourcePoint, bus.direction) + sign * directionalPitch * 0.5
  const sourcePerpendicularAxis = getPerpendicularAxis(
    sourcePoint,
    bus.direction,
  )
  const viaPoint = makePoint(viaAxis, sourcePerpendicularAxis, bus.direction)
  const targetLayerDoglegAxis =
    viaAxis + sign * Math.abs(track - sourcePerpendicularAxis)
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

  appendSegment(segments, viaPoint, doglegPoint, traceWidth, targetLayer)
  if (distance(viaPoint, doglegPoint) >= 1e-9) {
    route.push({
      route_type: "wire",
      x: doglegPoint.x,
      y: doglegPoint.y,
      width: traceWidth,
      layer: targetLayer,
    })
  }
  appendSegment(segments, doglegPoint, exitPoint, traceWidth, targetLayer)
  route.push({
    route_type: "wire",
    x: exitPoint.x,
    y: exitPoint.y,
    width: traceWidth,
    layer: targetLayer,
  })

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

  for (const connectionOrder of getConnectionOrders(bus)) {
    const candidatePlans: FanoutRoutePlan[] = []
    let orderIsClear = true
    for (const preparedConnection of connectionOrder) {
      let acceptedPlan: FanoutRoutePlan | null = null
      for (const track of getTrackCandidates({
        bus,
        connection: preparedConnection,
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

  return null
}
