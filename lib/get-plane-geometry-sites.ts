import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { distance } from "./geometry"
import type { RouteBusParams } from "./route-bus"
import { getStraightOr45ConnectorVariants } from "./route-bus/source-escape"
import {
  getObstacleAxisAlignedBounds,
  ObstacleSpatialIndex,
} from "./route-via-minimal-winding"
import type { Point2D } from "./types"

function getAxisCoordinates(
  params: { axis: "x" | "y"; obstacles: readonly Obstacle[] },
  route: RouteBusParams,
): number[] {
  const { axis, obstacles } = params
  const { bus, viaDiameter, traceWidth, clearance } = route
  const minimum = axis === "x" ? "minX" : "minY"
  const maximum = axis === "x" ? "maxX" : "maxY"
  const bounds = bus.sharedBoundary
  const padBounds = getObstacleAxisAlignedBounds(
    bus.connections[0]!.sourceObstacle,
  )
  const padRadius = (padBounds[maximum] - padBounds[minimum]) / 2
  const rows = axis === "x" ? bus.xCoordinates : bus.yCoordinates
  const padCoordinates = rows.flatMap((row, index) => [
    row,
    ...(index > 0 ? [(row + rows[index - 1]!) / 2] : []),
    ...[traceWidth / 2, viaDiameter / 2].flatMap((radius) => [
      row - padRadius - radius - clearance,
      row + padRadius + radius + clearance,
    ]),
  ])
  const obstacleCoordinates = obstacles
    .filter((obstacle) => !obstacle.componentId)
    .flatMap((obstacle) => {
      const box = getObstacleAxisAlignedBounds(obstacle)
      const margin = obstacle.isCopperPour ? 0 : viaDiameter / 2 + clearance
      return [
        obstacle.center[axis],
        box[minimum] - margin,
        box[maximum] + margin,
      ]
    })
  const insetMinimum = bounds[minimum] + viaDiameter / 2
  const insetMaximum = bounds[maximum] - viaDiameter / 2
  const coordinates = new Set([
    insetMinimum,
    insetMaximum,
    ...[...padCoordinates, ...obstacleCoordinates]
      .filter(
        (coordinate) => coordinate > insetMinimum && coordinate < insetMaximum,
      )
      .map((coordinate) => Math.round(coordinate * 1e8) / 1e8),
  ])
  const sorted = [...coordinates].sort((first, second) => first - second)
  return sorted.flatMap((coordinate, index) =>
    index > 0
      ? [coordinate, (coordinate + sorted[index - 1]!) / 2]
      : [coordinate],
  )
}

export function getPlaneGeometrySites(route: RouteBusParams): Point2D[] {
  const obstacles = new ObstacleSpatialIndex(route.srj.obstacles).queryBounds(
    route.bus.sharedBoundary,
    route.viaDiameter / 2 + route.clearance,
  )
  const xs = getAxisCoordinates({ axis: "x", obstacles }, route)
  const ys = getAxisCoordinates({ axis: "y", obstacles }, route)
  const source = route.bus.connections[0]!.sourcePoint
  return xs
    .flatMap((x) => ys.map((y) => ({ x, y })))
    .sort((first, second) => distance(first, source) - distance(second, source))
}

export function* getPlaneGeometryConnectors(
  source: Point2D,
  site: Point2D,
): Generator<Point2D[]> {
  yield* getStraightOr45ConnectorVariants(source, site)
  const dx = site.x - source.x
  const dy = site.y - source.y
  const risingDiagonalOffset = (dx + dy) / 2
  const fallingDiagonalOffset = (dx - dy) / 2
  for (const corner of [
    { x: site.x, y: source.y },
    { x: source.x, y: site.y },
    { x: source.x + risingDiagonalOffset, y: source.y + risingDiagonalOffset },
    {
      x: source.x + fallingDiagonalOffset,
      y: source.y - fallingDiagonalOffset,
    },
  ]) {
    if (distance(corner, source) > 1e-9 && distance(corner, site) > 1e-9)
      yield [source, corner, site]
  }
}
