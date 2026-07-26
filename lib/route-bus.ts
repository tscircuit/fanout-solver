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

interface TrackLayout {
  spread: number
  offsetSteps: number
  reverse: boolean
  preserveSourceSpacing: boolean
}

const TRACK_LAYOUTS: TrackLayout[] = [
  {
    spread: 1,
    offsetSteps: 0,
    reverse: false,
    preserveSourceSpacing: true,
  },
  {
    spread: 1.25,
    offsetSteps: 0,
    reverse: false,
    preserveSourceSpacing: true,
  },
  {
    spread: 1.5,
    offsetSteps: 0,
    reverse: false,
    preserveSourceSpacing: true,
  },
  {
    spread: 1,
    offsetSteps: 0,
    reverse: false,
    preserveSourceSpacing: false,
  },
  {
    spread: 1.25,
    offsetSteps: 0,
    reverse: false,
    preserveSourceSpacing: false,
  },
  {
    spread: 1.5,
    offsetSteps: 0,
    reverse: false,
    preserveSourceSpacing: false,
  },
  {
    spread: 1,
    offsetSteps: -0.5,
    reverse: false,
    preserveSourceSpacing: false,
  },
  {
    spread: 1,
    offsetSteps: 0.5,
    reverse: false,
    preserveSourceSpacing: false,
  },
  {
    spread: 2,
    offsetSteps: 0,
    reverse: false,
    preserveSourceSpacing: false,
  },
  {
    spread: 1.25,
    offsetSteps: 0,
    reverse: true,
    preserveSourceSpacing: false,
  },
]

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
      return bus.componentBounds.maxX + breakoutMargin
    case "left":
      return bus.componentBounds.minX - breakoutMargin
    case "up":
      return bus.componentBounds.maxY + breakoutMargin
    case "down":
      return bus.componentBounds.minY - breakoutMargin
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

function getTrackMap(params: {
  bus: PreparedBus
  traceWidth: number
  clearance: number
  layout: TrackLayout
}): Map<string, number> {
  const { bus, traceWidth, clearance, layout } = params
  const sign = directionSign(bus.direction)
  const sortedConnections = [...bus.connections].sort((a, b) => {
    const perpendicularDifference =
      getPerpendicularAxis(a.sourcePoint, bus.direction) -
      getPerpendicularAxis(b.sourcePoint, bus.direction)
    if (Math.abs(perpendicularDifference) > 1e-6) {
      return perpendicularDifference
    }
    return (
      sign *
      (getAxis(b.sourcePoint, bus.direction) -
        getAxis(a.sourcePoint, bus.direction))
    )
  })
  if (layout.reverse) sortedConnections.reverse()

  const trackPitch = (traceWidth + clearance) * layout.spread
  if (layout.preserveSourceSpacing) {
    const connectionsBySourceTrack = new Map<number, PreparedConnection[]>()
    for (const connection of sortedConnections) {
      const sourceTrack = getPerpendicularAxis(
        connection.sourcePoint,
        bus.direction,
      )
      const trackKey = Math.round(sourceTrack * 1e6)
      const sharingConnections = connectionsBySourceTrack.get(trackKey) ?? []
      sharingConnections.push(connection)
      connectionsBySourceTrack.set(trackKey, sharingConnections)
    }
    const trackEntries: Array<[string, number]> = []
    for (const sharingConnections of connectionsBySourceTrack.values()) {
      const sourceTrack = getPerpendicularAxis(
        sharingConnections[0]!.sourcePoint,
        bus.direction,
      )
      for (let index = 0; index < sharingConnections.length; index++) {
        trackEntries.push([
          sharingConnections[index]!.connection.name,
          sourceTrack -
            ((sharingConnections.length - 1) * trackPitch) / 2 +
            index * trackPitch +
            layout.offsetSteps * trackPitch,
        ])
      }
    }
    return new Map(trackEntries)
  }

  const center =
    bus.connections.reduce(
      (sum, connection) =>
        sum + getPerpendicularAxis(connection.sourcePoint, bus.direction),
      0,
    ) / bus.connections.length
  const firstTrack =
    center -
    ((sortedConnections.length - 1) * trackPitch) / 2 +
    layout.offsetSteps * trackPitch
  return new Map(
    sortedConnections.map((connection, index) => [
      connection.connection.name,
      firstTrack + index * trackPitch,
    ]),
  )
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

  for (const layout of TRACK_LAYOUTS) {
    const trackByConnectionName = getTrackMap({
      bus,
      traceWidth,
      clearance,
      layout,
    })
    const candidatePlans: FanoutRoutePlan[] = []
    let layoutIsClear = true
    for (const preparedConnection of bus.connections) {
      const track = trackByConnectionName.get(
        preparedConnection.connection.name,
      )
      if (track === undefined) {
        throw new Error(
          `FanoutSolver: no track was assigned to "${preparedConnection.connection.name}"`,
        )
      }
      const plan = buildPlan({
        preparedConnection,
        bus,
        targetLayer,
        track,
        exitAxis,
        layerNames,
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
      })
      if (
        !planIsClear({
          plan,
          otherPlans: [...acceptedPlans, ...candidatePlans],
          srj,
          clearance,
        })
      ) {
        layoutIsClear = false
        break
      }
      candidatePlans.push(plan)
    }
    if (layoutIsClear) return candidatePlans
  }

  return null
}
