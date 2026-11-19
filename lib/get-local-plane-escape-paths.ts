import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distanceSegmentToObstacle,
  pointIsInsideObstacle,
} from "./geometry"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import { obstacleSharesElectricalNet } from "./net-identity"
import {
  ObstacleSpatialIndex,
  getObstacleAxisAlignedBounds,
} from "./route-via-minimal-winding"
import type { RouteBusParams } from "./route-bus"
import { directionSign, getAxis } from "./route-bus/directions"
import { getStraightOr45ConnectorVariants } from "./route-bus/source-escape"
import { getPlanSegments, getPlanVias } from "./route-bus/plan-copper"
import type {
  FanoutDirection,
  FanoutRoutePlan,
  Point2D,
  PreparedConnection,
  RoutedVia,
} from "./types"

function pointsInDirection(vector: Point2D, direction: FanoutDirection) {
  return getAxis(vector, direction) * directionSign(direction) > 1e-9
}

/** Preserve a compatible preferred direction on a diagonal. Otherwise report
 * the heading of the physical lead rather than the original search bias. */
export function getPlaneEscapeDirection(
  lead: { start: Point2D; end: Point2D },
  preferred: FanoutDirection,
): FanoutDirection {
  const dx = lead.end.x - lead.start.x
  const dy = lead.end.y - lead.start.y
  if (pointsInDirection({ x: dx, y: dy }, preferred)) return preferred
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right"
  return dy < 0 ? "down" : "up"
}

/** A diagonal escape may follow either of its two positive cardinal headings.
 * A requested via-in-pad drop has no source-layer lead to constrain. */
export function planeEscapeStartsInDirection(
  plan: FanoutRoutePlan,
  direction: FanoutDirection,
): boolean {
  const lead = plan.segments.find(
    (segment) =>
      segment.layer === plan.sourceLayer &&
      !pointIsInsideObstacle(segment.end, plan.sourceObstacle),
  )
  if (!lead) {
    return !!plan.via && distance(plan.sourcePoint, plan.via.center) <= 1e-9
  }
  return pointsInDirection(
    { x: lead.end.x - lead.start.x, y: lead.end.y - lead.start.y },
    direction,
  )
}

/** Opposing blind drills can share a landing layer. Drills through the
 * same layer interval must leave disjoint holes. */
function drillsOverlap(a: RoutedVia, b: RoutedVia): boolean {
  return (
    distance(a.center, b.center) <
      (a.holeDiameter + b.holeDiameter) / 2 - 1e-9 &&
    a.spanLayers.filter((layer) => b.spanLayers.includes(layer)).length > 1
  )
}

/** Check any retained or newly generated plane route against the physical request. */
export function createPlaneRequestCheck(options: {
  srj: SimpleRouteJson
  targetLayer: string
  connectionName: string
  viaDiameter: number
  clearance: number
  requiredLeadDirection?: FanoutDirection
}): (plan: FanoutRoutePlan) => boolean {
  const {
    srj,
    targetLayer,
    connectionName,
    viaDiameter,
    clearance,
    requiredLeadDirection,
  } = options
  const planePours = srj.obstacles.filter(
    (obstacle) =>
      obstacle.isCopperPour && obstacle.layers.includes(targetLayer),
  )
  const sameNet: Obstacle[] = []
  const foreign: Obstacle[] = []
  for (const pour of planePours) {
    if (obstacleSharesElectricalNet(srj, pour, connectionName))
      sameNet.push(pour)
    else foreign.push(pour)
  }
  const lands = (point: Point2D) =>
    !planePours.length ||
    (sameNet.some((pour) => pointIsInsideObstacle(point, pour)) &&
      foreign.every(
        (pour) =>
          distancePointToObstacle(point, pour) >=
          viaDiameter / 2 + clearance - 1e-9,
      ))
  return (plan) =>
    plan.connectionName === connectionName &&
    plan.termination.type === "plane" &&
    plan.termination.layer === targetLayer &&
    plan.targetLayer === targetLayer &&
    !!plan.via &&
    lands(plan.via.center) &&
    (!plan.planeEndpointVia ||
      (lands(plan.planeEndpointVia.center) &&
        !drillsOverlap(plan.via, plan.planeEndpointVia))) &&
    (!requiredLeadDirection ||
      planeEscapeStartsInDirection(plan, requiredLeadDirection))
}

/** Complete the ordinary 45-degree connectors with the two orthogonal
 * elbows in the board axes and the two in the diagonal axes. */
function* pathsToSite(source: Point2D, site: Point2D) {
  yield* getStraightOr45ConnectorVariants(source, site)
  const dx = site.x - source.x
  const dy = site.y - source.y
  const rising = (dx + dy) / 2
  const falling = (dx - dy) / 2
  for (const corner of [
    { x: site.x, y: source.y },
    { x: source.x, y: site.y },
    { x: source.x + rising, y: source.y + rising },
    { x: source.x + falling, y: source.y - falling },
  ]) {
    if (distance(corner, source) > 1e-9 && distance(corner, site) > 1e-9)
      yield [source, corner, site]
  }
}

/** The component grid supplies local interstices. Finite copper and already
 * occupied sites add coordinates that are independent of the pad pitch.
 * These are placement proposals. The shared plane and clearance validators
 * decide which proposals can be emitted. */
export function* getLocalPlaneEscapePaths(
  params: RouteBusParams,
  options: {
    connection: PreparedConnection
    traceWidth: number
    requiredLeadDirection?: FanoutDirection
  },
) {
  const { srj, bus, viaDiameter, clearance } = params
  const { sourcePoint, sourceObstacle, sourceLayer } = options.connection
  const { sharedBoundary: bounds } = bus
  const viaRadius = viaDiameter / 2
  const wireRadius = options.traceWidth / 2
  const viaMargin = viaRadius + clearance
  const nearbyObstacles = new ObstacleSpatialIndex(srj.obstacles).queryBounds(
    bounds,
    viaMargin,
  )
  const padBounds = getObstacleAxisAlignedBounds(sourceObstacle)
  const getCandidateCoordinates = (axis: "x" | "y") => {
    const low = axis === "x" ? "minX" : "minY"
    const high = axis === "x" ? "maxX" : "maxY"
    const rows = axis === "x" ? bus.xCoordinates : bus.yCoordinates
    const padRadius = (padBounds[high] - padBounds[low]) / 2
    const edges = new Set([bounds[low] + viaRadius, bounds[high] - viaRadius])
    const add = (coordinate: number) => {
      if (
        coordinate > bounds[low] + viaRadius &&
        coordinate < bounds[high] - viaRadius
      )
        edges.add(Math.round(coordinate * 1e8) / 1e8)
    }
    for (const [index, row] of rows.entries()) {
      add(row)
      if (index) add((row + rows[index - 1]!) / 2)
      for (const radius of [wireRadius, viaRadius]) {
        add(row - padRadius - radius - clearance)
        add(row + padRadius + radius + clearance)
      }
    }
    for (const obstacle of nearbyObstacles) {
      if (obstacle.componentId) continue
      const box = getObstacleAxisAlignedBounds(obstacle)
      const margin = obstacle.isCopperPour ? 0 : viaMargin
      add(obstacle.center[axis])
      add(box[low] - margin)
      add(box[high] + margin)
    }
    const sorted = [...edges].sort((a, b) => a - b)
    return sorted.flatMap((value, index) =>
      index ? [value, (value + sorted[index - 1]!) / 2] : [value],
    )
  }
  const xs = getCandidateCoordinates("x")
  const ys = getCandidateCoordinates("y")
  const sites = xs.flatMap((x) => ys.map((y) => ({ x, y })))
  // Sample beside supplied and already selected copper. Layer, net and exact
  // swept-wire clearance stay with the common clearance validator.
  const addAlong = ({
    start,
    end,
    radius,
  }: {
    start: Point2D
    end: Point2D
    radius: number
  }) => {
    const gap = radius + viaMargin
    const left = Math.min(start.x, end.x) - gap
    const right = Math.max(start.x, end.x) + gap
    const bottom = Math.min(start.y, end.y) - gap
    const top = Math.max(start.y, end.y) + gap
    for (const y of ys)
      if (y >= bottom && y <= top) sites.push({ x: left, y }, { x: right, y })
    for (const x of xs)
      if (x >= left && x <= right) sites.push({ x, y: bottom }, { x, y: top })
  }
  const copper = [
    ...getAllRoutedTraceCopper(srj, params.allowBlindAndBuriedVias ?? true),
    ...params.acceptedPlans.map((plan) => ({
      segments: getPlanSegments(plan),
      vias: getPlanVias(plan),
    })),
  ]
  for (const route of copper) {
    for (const via of route.vias)
      addAlong({ start: via.center, end: via.center, radius: via.diameter / 2 })
    for (const wire of route.segments)
      addAlong({ start: wire.start, end: wire.end, radius: wire.width / 2 })
  }
  // Check fixed pads cheaply before building each plan. The caller applies
  // the complete plane, copper clearance and physical pad-exit rules.
  const sourcePads = bus.componentObstacles.filter(
    (obstacle) =>
      !obstacle.isCopperPour &&
      obstacle.layers.includes(sourceLayer) &&
      obstacle.connectedTo.length > 0,
  )
  const padIndex = new ObstacleSpatialIndex(sourcePads)
  const blockedLead = new ObstacleSpatialIndex(
    sourcePads.filter(
      (obstacle) =>
        obstacle !== sourceObstacle &&
        !obstacleSharesElectricalNet(
          srj,
          obstacle,
          options.connection.connection.name,
        ),
    ),
  )
  const checkWire = (start: Point2D, end: Point2D) => {
    const wire = { start, end, layer: sourceLayer, width: options.traceWidth }
    const margin = wireRadius + clearance
    return blockedLead
      .querySegment(wire, margin)
      .every(
        (obstacle) =>
          distanceSegmentToObstacle(wire, obstacle) >= margin - 1e-9,
      )
  }
  const contained = (point: Point2D, radius: number) =>
    point.x >= bounds.minX + radius - 1e-9 &&
    point.x <= bounds.maxX - radius + 1e-9 &&
    point.y >= bounds.minY + radius - 1e-9 &&
    point.y <= bounds.maxY - radius + 1e-9
  const seen = new Set<string>()
  const lastBlocked = new Map<number, number>()
  for (const site of sites.sort(
    (a, b) => distance(a, sourcePoint) - distance(b, sourcePoint),
  )) {
    const key = site.x + "," + site.y
    if (seen.has(key) || !contained(site, viaRadius)) continue
    seen.add(key)
    if (
      padIndex
        .queryBounds(
          { minX: site.x, maxX: site.x, minY: site.y, maxY: site.y },
          viaMargin,
        )
        .some(
          (obstacle) =>
            distancePointToObstacle(site, obstacle) < viaMargin - 1e-9,
        )
    )
      continue
    for (const path of pathsToSite(sourcePoint, site)) {
      const first = path[1]!
      const vector = { x: first.x - sourcePoint.x, y: first.y - sourcePoint.y }
      if (
        !contained(first, wireRadius) ||
        (options.requiredLeadDirection &&
          !pointsInDirection(vector, options.requiredLeadDirection))
      )
        continue
      const heading = Math.round(Math.atan2(vector.y, vector.x) / (Math.PI / 4))
      const length = distance(sourcePoint, first)
      if (length >= (lastBlocked.get(heading) ?? Infinity)) continue
      if (!checkWire(sourcePoint, first)) {
        lastBlocked.set(heading, length)
        continue
      }
      yield { path, checkWire }
    }
  }
}
