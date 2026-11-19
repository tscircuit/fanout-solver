import {
  distance,
  distancePointToObstacle,
  distanceSegmentToObstacle,
} from "./geometry"
import {
  getPlaneGeometryConnectors,
  getPlaneGeometrySites,
} from "./get-plane-geometry-sites"
import { obstacleSharesElectricalNet } from "./net-identity"
import type { RouteBusParams } from "./route-bus"
import { directionSign, getAxis, pointIsInsideBounds } from "./route-bus/directions"
import { ObstacleSpatialIndex } from "./route-via-minimal-winding"
import type { Point2D, RoutedSegment } from "./types"

type PlaneLeadHeading = number

function wireIsClear(
  wire: RoutedSegment,
  rules: { index: ObstacleSpatialIndex; clearance: number },
): boolean {
  const margin = wire.width / 2 + rules.clearance
  return rules.index
    .querySegment(wire, margin)
    .every((obstacle) => distanceSegmentToObstacle(wire, obstacle) >= margin - 1e-9)
}

export function* getPlaneGeometryPaths(
  route: RouteBusParams,
): Generator<Point2D[]> {
  const { srj, bus, viaDiameter, traceWidth, clearance } = route
  const connection = bus.connections[0]!
  const source = connection.sourcePoint
  const sourcePads = bus.componentObstacles.filter(
    (obstacle) =>
      !obstacle.isCopperPour &&
      obstacle.layers.includes(connection.sourceLayer) &&
      obstacle.connectedTo.length > 0,
  )
  const padIndex = new ObstacleSpatialIndex(sourcePads)
  const wireRules = {
    index: new ObstacleSpatialIndex(
      sourcePads.filter(
        (obstacle) =>
          obstacle !== connection.sourceObstacle &&
          !obstacleSharesElectricalNet(srj, obstacle, connection.connection.name),
      ),
    ),
    clearance,
  }
  const wireBounds = {
    minX: bus.sharedBoundary.minX + traceWidth / 2,
    maxX: bus.sharedBoundary.maxX - traceWidth / 2,
    minY: bus.sharedBoundary.minY + traceWidth / 2,
    maxY: bus.sharedBoundary.maxY - traceWidth / 2,
  }
  const sourceWire = { layer: connection.sourceLayer, width: traceWidth }
  const lastBlocked = new Map<PlaneLeadHeading, number>()
  const viaMargin = viaDiameter / 2 + clearance
  for (const site of getPlaneGeometrySites(route)) {
    const nearbyPads = padIndex.queryBounds(
      { minX: site.x, maxX: site.x, minY: site.y, maxY: site.y },
      viaMargin,
    )
    if (
      nearbyPads.some(
        (obstacle) => distancePointToObstacle(site, obstacle) < viaMargin - 1e-9,
      )
    )
      continue
    for (const path of getPlaneGeometryConnectors(source, site)) {
      const first = path[1]!
      const followsDirection =
        (getAxis(first, bus.direction) - getAxis(source, bus.direction)) *
          directionSign(bus.direction) >
        1e-9
      if (!pointIsInsideBounds(first, wireBounds) || !followsDirection) continue
      const heading = Math.round(
        Math.atan2(first.y - source.y, first.x - source.x) / (Math.PI / 4),
      )
      const length = distance(source, first)
      if (length >= (lastBlocked.get(heading) ?? Infinity)) continue
      if (!wireIsClear({ ...sourceWire, start: source, end: first }, wireRules)) {
        lastBlocked.set(heading, length)
        continue
      }
      if (
        path.length > 2 &&
        !wireIsClear({ ...sourceWire, start: first, end: site }, wireRules)
      )
        continue
      yield path
    }
  }
}
