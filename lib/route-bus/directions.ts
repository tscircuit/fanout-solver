import { getCornerBandSide, getExitEdgeForDirection } from "../boundary-exit"
import type { Bounds, FanoutDirection, Point2D, PreparedBus } from "../types"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

export function allowsViaInPad(srj: SimpleRouteJson): boolean {
  return (
    (srj as SimpleRouteJson & { allowViaInPad?: boolean }).allowViaInPad ===
    true
  )
}

export function isHorizontal(direction: FanoutDirection): boolean {
  return direction === "left" || direction === "right"
}

export function directionSign(direction: FanoutDirection): number {
  return direction === "right" || direction === "up" ? 1 : -1
}

export function getAxis(point: Point2D, direction: FanoutDirection): number {
  return isHorizontal(direction) ? point.x : point.y
}

export function getPerpendicularAxis(
  point: Point2D,
  direction: FanoutDirection,
): number {
  return isHorizontal(direction) ? point.y : point.x
}

export function getCornerSide(
  bus: PreparedBus,
): "minimum" | "maximum" | undefined {
  return getCornerBandSide(bus.exitEdge, bus.preferredExit)
}

export function getLocalCornerSide(
  bus: PreparedBus,
): "minimum" | "maximum" | undefined {
  return getCornerBandSide(
    getExitEdgeForDirection(bus.direction),
    bus.preferredExit,
  )
}

export function busUsesCoordinatedWindingChannel(bus: PreparedBus): boolean {
  return Boolean(
    bus.exitEdge &&
      bus.termination.type === "boundary" &&
      bus.connections.length > 0 &&
      bus.connections.every(
        (connection) => connection.hasExplicitLayeredExitTarget === true,
      ),
  )
}

export function makePoint({
  axis,
  perpendicularAxis,
  direction,
}: {
  axis: number
  perpendicularAxis: number
  direction: FanoutDirection
}): Point2D {
  return isHorizontal(direction)
    ? { x: axis, y: perpendicularAxis }
    : { x: perpendicularAxis, y: axis }
}

export function getExitAxis(
  bus: PreparedBus,
  direction: FanoutDirection = bus.direction,
): number {
  switch (direction) {
    case "right":
      return bus.sharedBoundary.maxX
    case "left":
      return bus.sharedBoundary.minX
    case "up":
      return bus.sharedBoundary.maxY
    case "down":
      return bus.sharedBoundary.minY
  }
}

export function getDirectionalPitch(bus: PreparedBus): number {
  return isHorizontal(bus.direction) ? bus.pitchX : bus.pitchY
}

export function getPerpendicularPitch(bus: PreparedBus): number {
  return isHorizontal(bus.direction) ? bus.pitchY : bus.pitchX
}

export function getRoutableBounds(
  srjBounds: SimpleRouteJson["bounds"],
  sharedBoundary: Bounds,
): SimpleRouteJson["bounds"] {
  // Fanout routes must reach the shared boundary and terminate exactly on it.
  // When that boundary sits outside srj.bounds -- which is what
  // fanoutBoundaryPadding does, since it pads the boundary without widening
  // the routing area -- containment has to follow the boundary, or every plan
  // is rejected before its geometry is ever considered.
  return {
    minX: Math.min(srjBounds.minX, sharedBoundary.minX),
    maxX: Math.max(srjBounds.maxX, sharedBoundary.maxX),
    minY: Math.min(srjBounds.minY, sharedBoundary.minY),
    maxY: Math.max(srjBounds.maxY, sharedBoundary.maxY),
  }
}

export function pointIsInsideBounds(
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
