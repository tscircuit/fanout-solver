import type { Obstacle } from "@tscircuit/capacity-autorouter"
import type { Point2D, RoutedSegment } from "./types"

const EPSILON = 1e-9

type ShapeAwareObstacle = Obstacle & {
  shape?: "circle"
  ccwRotationDegrees?: number
}

function obstacleIsCircular(obstacle: Obstacle): boolean {
  return (obstacle as ShapeAwareObstacle).shape === "circle"
}

function toObstacleLocalPoint(point: Point2D, obstacle: Obstacle): Point2D {
  const rotationRadians =
    (-((obstacle as ShapeAwareObstacle).ccwRotationDegrees ?? 0) * Math.PI) /
    180
  const dx = point.x - obstacle.center.x
  const dy = point.y - obstacle.center.y
  return {
    x: dx * Math.cos(rotationRadians) - dy * Math.sin(rotationRadians),
    y: dx * Math.sin(rotationRadians) + dy * Math.cos(rotationRadians),
  }
}

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function distancePointToSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D,
): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const rawT =
    lengthSquared < EPSILON
      ? 0
      : ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  const t = Math.max(0, Math.min(1, rawT))
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

function cross(origin: Point2D, a: Point2D, b: Point2D): number {
  return (
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
  )
}

function segmentsProperlyCross(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
): boolean {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  )
}

export function distanceSegmentToSegment(
  firstStart: Point2D,
  firstEnd: Point2D,
  secondStart: Point2D,
  secondEnd: Point2D,
): number {
  if (segmentsProperlyCross(firstStart, firstEnd, secondStart, secondEnd)) {
    return 0
  }
  return Math.min(
    distancePointToSegment(firstStart, secondStart, secondEnd),
    distancePointToSegment(firstEnd, secondStart, secondEnd),
    distancePointToSegment(secondStart, firstStart, firstEnd),
    distancePointToSegment(secondEnd, firstStart, firstEnd),
  )
}

export function pointIsInsideObstacle(
  point: Point2D,
  obstacle: Obstacle,
  tolerance = EPSILON,
): boolean {
  if (obstacleIsCircular(obstacle)) {
    return distance(point, obstacle.center) <= obstacle.width / 2 + tolerance
  }
  const localPoint = toObstacleLocalPoint(point, obstacle)
  return (
    Math.abs(localPoint.x) <= obstacle.width / 2 + tolerance &&
    Math.abs(localPoint.y) <= obstacle.height / 2 + tolerance
  )
}

export function distancePointToObstacle(
  point: Point2D,
  obstacle: Obstacle,
): number {
  if (obstacleIsCircular(obstacle)) {
    return Math.max(0, distance(point, obstacle.center) - obstacle.width / 2)
  }
  const localPoint = toObstacleLocalPoint(point, obstacle)
  const dx = Math.max(Math.abs(localPoint.x) - obstacle.width / 2, 0)
  const dy = Math.max(Math.abs(localPoint.y) - obstacle.height / 2, 0)
  return Math.hypot(dx, dy)
}

export function distanceSegmentToObstacle(
  segment: RoutedSegment,
  obstacle: Obstacle,
): number {
  if (obstacleIsCircular(obstacle)) {
    return Math.max(
      0,
      distancePointToSegment(obstacle.center, segment.start, segment.end) -
        obstacle.width / 2,
    )
  }
  const localStart = toObstacleLocalPoint(segment.start, obstacle)
  const localEnd = toObstacleLocalPoint(segment.end, obstacle)
  if (
    Math.abs(localStart.x) <= obstacle.width / 2 + EPSILON &&
    Math.abs(localStart.y) <= obstacle.height / 2 + EPSILON
  ) {
    return 0
  }
  if (
    Math.abs(localEnd.x) <= obstacle.width / 2 + EPSILON &&
    Math.abs(localEnd.y) <= obstacle.height / 2 + EPSILON
  ) {
    return 0
  }
  const minX = -obstacle.width / 2
  const maxX = obstacle.width / 2
  const minY = -obstacle.height / 2
  const maxY = obstacle.height / 2
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]

  let minimumDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < corners.length; index++) {
    minimumDistance = Math.min(
      minimumDistance,
      distanceSegmentToSegment(
        localStart,
        localEnd,
        corners[index]!,
        corners[(index + 1) % corners.length]!,
      ),
    )
  }
  return minimumDistance
}

export function segmentsAreClear(
  first: RoutedSegment,
  second: RoutedSegment,
  clearance: number,
): boolean {
  if (first.layer !== second.layer) return true
  const requiredDistance = (first.width + second.width) / 2 + clearance
  return (
    distanceSegmentToSegment(
      first.start,
      first.end,
      second.start,
      second.end,
    ) >=
    requiredDistance - EPSILON
  )
}
