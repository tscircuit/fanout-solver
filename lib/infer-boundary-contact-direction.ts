import { pointIsInsideBounds } from "./route-bus/directions"
import type { Bounds, FanoutDirection, PreparedConnection } from "./types"

/** Prefer the single boundary edge already touched by every target's copper. */
export function inferBoundaryContactDirection(params: {
  connections: PreparedConnection[]
  sharedBoundary: Bounds
  traceWidth: number
}): FanoutDirection | undefined {
  const { connections, sharedBoundary, traceWidth } = params
  let direction: FanoutDirection | undefined
  for (const connection of connections) {
    const target = connection.exitTargetPoint ?? connection.targetPoint
    if (!pointIsInsideBounds(target, sharedBoundary)) return undefined
    const boundaryDistances = {
      left: target.x - sharedBoundary.minX,
      right: sharedBoundary.maxX - target.x,
      up: sharedBoundary.maxY - target.y,
      down: target.y - sharedBoundary.minY,
    }
    const contacts = (["left", "right", "up", "down"] as const).filter(
      (candidate) => Math.abs(boundaryDistances[candidate]) <= traceWidth / 2,
    )
    // A corner or a bus spanning different edges keeps displacement inference.
    if (contacts.length !== 1) return undefined
    if (direction !== undefined && direction !== contacts[0]) return undefined
    direction = contacts[0]
  }
  return direction
}
