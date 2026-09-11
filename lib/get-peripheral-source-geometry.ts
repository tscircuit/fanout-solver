import type { Bounds, PreparedBus } from "./types"

export interface PeripheralSourceGeometry {
  padBounds: Bounds
  sourceBoundary: Bounds
  center: { x: number; y: number }
  padPitch: number
}

/** Build the pad-aligned inner boundary used by two-layer source crossbars. */
export function getPeripheralSourceGeometry(params: {
  bus: PreparedBus
  traceWidth: number
  clearance: number
}): PeripheralSourceGeometry | null {
  const { bus, traceWidth, clearance } = params
  const sourceObstacles = bus.componentObstacles.filter((obstacle) =>
    obstacle.layers.includes("top"),
  )
  if (sourceObstacles.length === 0) return null

  const padBounds = {
    minX: Math.min(
      ...sourceObstacles.map(
        (obstacle) => obstacle.center.x - obstacle.width / 2,
      ),
    ),
    maxX: Math.max(
      ...sourceObstacles.map(
        (obstacle) => obstacle.center.x + obstacle.width / 2,
      ),
    ),
    minY: Math.min(
      ...sourceObstacles.map(
        (obstacle) => obstacle.center.y - obstacle.height / 2,
      ),
    ),
    maxY: Math.max(
      ...sourceObstacles.map(
        (obstacle) => obstacle.center.y + obstacle.height / 2,
      ),
    ),
  }
  const center = {
    x: (padBounds.minX + padBounds.maxX) / 2,
    y: (padBounds.minY + padBounds.maxY) / 2,
  }
  const pitch = traceWidth + clearance
  const padPitch = Math.max(bus.pitchX, bus.pitchY)
  if (
    !Number.isFinite(pitch) ||
    pitch <= 0 ||
    !Number.isFinite(padPitch) ||
    padPitch <= 0
  )
    return null

  const halfWidth =
    Math.ceil(
      ((padBounds.maxX - padBounds.minX) / 2 + padPitch + pitch) / pitch,
    ) * pitch
  const halfHeight =
    Math.ceil(
      ((padBounds.maxY - padBounds.minY) / 2 + padPitch + pitch) / pitch,
    ) * pitch
  const sourceBoundary = {
    minX: center.x - halfWidth,
    maxX: center.x + halfWidth,
    minY: center.y - halfHeight,
    maxY: center.y + halfHeight,
  }
  if (
    sourceBoundary.minX <= bus.sharedBoundary.minX ||
    sourceBoundary.maxX >= bus.sharedBoundary.maxX ||
    sourceBoundary.minY <= bus.sharedBoundary.minY ||
    sourceBoundary.maxY >= bus.sharedBoundary.maxY
  )
    return null

  return { padBounds, sourceBoundary, center, padPitch }
}
