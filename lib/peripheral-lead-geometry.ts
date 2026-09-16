import type { Obstacle } from "@tscircuit/capacity-autorouter"
import type { Bounds, FanoutDirection, Point2D } from "./types"

const EPSILON = 1e-7

export function getAxisAlignedObstacleSize(obstacle: Obstacle): Point2D | null {
  const shaped = obstacle as Obstacle & {
    shape?: string
    ccwRotationDegrees?: number
  }
  if (shaped.shape === "circle" || obstacle.type !== "rect") return null
  const quarterTurns = (shaped.ccwRotationDegrees ?? 0) / 90
  if (Math.abs(quarterTurns - Math.round(quarterTurns)) > EPSILON) return null
  return Math.abs(Math.round(quarterTurns)) % 2 === 0
    ? { x: obstacle.width, y: obstacle.height }
    : { x: obstacle.height, y: obstacle.width }
}

function getObstacleBounds(obstacles: readonly Obstacle[]): Bounds | null {
  const bounds: Bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  }
  for (const obstacle of obstacles) {
    const size = getAxisAlignedObstacleSize(obstacle)
    if (!size) return null
    bounds.minX = Math.min(bounds.minX, obstacle.center.x - size.x / 2)
    bounds.maxX = Math.max(bounds.maxX, obstacle.center.x + size.x / 2)
    bounds.minY = Math.min(bounds.minY, obstacle.center.y - size.y / 2)
    bounds.maxY = Math.max(bounds.maxY, obstacle.center.y + size.y / 2)
  }
  return Number.isFinite(bounds.minX) ? bounds : null
}

function getOutwardDirection(
  bounds: Bounds,
  obstacle: Obstacle,
): FanoutDirection | null {
  const size = getAxisAlignedObstacleSize(obstacle)
  if (!size || Math.abs(size.x - size.y) < EPSILON) return null
  const { center } = obstacle
  if (size.x > size.y) {
    if (Math.abs(center.x - size.x / 2 - bounds.minX) < EPSILON) return "left"
    if (Math.abs(center.x + size.x / 2 - bounds.maxX) < EPSILON) return "right"
  } else {
    if (Math.abs(center.y - size.y / 2 - bounds.minY) < EPSILON) return "down"
    if (Math.abs(center.y + size.y / 2 - bounds.maxY) < EPSILON) return "up"
  }
  return null
}

/**
 * Classify the elongated perimeter leads of a four-sided package by their
 * physical outward direction. Square exposed pads are intentionally ignored.
 */
export function getFourSidedPeripheralLeadDirections(
  obstacles: readonly Obstacle[],
): ReadonlyMap<Obstacle, FanoutDirection> | null {
  const bounds = getObstacleBounds(obstacles)
  if (!bounds) return null
  const directions = new Map<Obstacle, FanoutDirection>()
  const occupiedSides = new Set<FanoutDirection>()
  for (const obstacle of obstacles) {
    const direction = getOutwardDirection(bounds, obstacle)
    if (!direction) continue
    directions.set(obstacle, direction)
    occupiedSides.add(direction)
  }
  return occupiedSides.size === 4 ? directions : null
}
