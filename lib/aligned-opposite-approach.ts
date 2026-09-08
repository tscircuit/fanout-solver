import { hasOppositeFixedWideBus } from "./route-source-origin-buses"
import type { Point2D, PreparedBus } from "./types"

/** Keep future approaches where an opposite pair lies directly behind a wide bus's exits. */
export function hasAlignedOppositeApproach(
  buses: readonly PreparedBus[],
  exits: ReadonlyMap<number, Point2D>,
): boolean {
  return buses.some((wide) => {
    if (!hasOppositeFixedWideBus([wide])) return false
    const normal =
      wide.exitEdge === "left" || wide.exitEdge === "right" ? "x" : "y"
    const tangent = normal === "x" ? "y" : "x"
    const sign = wide.exitEdge === "left" || wide.exitEdge === "bottom" ? -1 : 1
    const center =
      normal === "x"
        ? (wide.componentBounds.minX + wide.componentBounds.maxX) / 2
        : (wide.componentBounds.minY + wide.componentBounds.maxY) / 2
    const wideTracks = wide.connections.map(
      (c) => exits.get(c.connectionIndex)?.[tangent],
    )
    if (
      wideTracks.some((value) => value === undefined || !Number.isFinite(value))
    )
      return false
    return buses.some((narrow) => {
      if (
        narrow.termination.type !== "boundary" ||
        narrow.connections.length !== 2 ||
        narrow.componentId !== wide.componentId ||
        narrow.exitEdge !== wide.exitEdge ||
        narrow.allowedLayers?.length !== 1 ||
        narrow.allowedLayers[0] === wide.allowedLayers![0] ||
        !narrow.connections.every(
          (c) => sign * (c.sourcePoint[normal] - center) < -1e-7,
        )
      )
        return false
      const narrowTracks = narrow.connections.map(
        (c) => exits.get(c.connectionIndex)?.[tangent],
      )
      if (
        narrowTracks.some(
          (value) => value === undefined || !Number.isFinite(value),
        )
      )
        return false
      const sources = narrow.connections.flatMap((c) => {
        const center =
          c.sourceObstacle?.center[tangent] ?? c.sourcePoint[tangent]
        const halfWidth =
          ((tangent === "x"
            ? c.sourceObstacle?.width
            : c.sourceObstacle?.height) ?? 0) / 2
        return [center - halfWidth, center + halfWidth]
      })
      return (
        Math.max(
          Math.min(...(wideTracks as number[])),
          Math.min(...(narrowTracks as number[])),
          Math.min(...sources),
        ) <=
        Math.min(
          Math.max(...(wideTracks as number[])),
          Math.max(...(narrowTracks as number[])),
          Math.max(...sources),
        )
      )
    })
  })
}
