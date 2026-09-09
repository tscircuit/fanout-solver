import { hasOppositeFixedWideBus } from "./route-source-origin-buses"
import type { Point2D, PreparedBus } from "./types"

/** Prefer new source sites when an opposite wide bus exits across the pad field. */
export function hasOppositeWideExitOverSourceField(
  buses: readonly PreparedBus[],
  exits: ReadonlyMap<number, Point2D>,
): boolean {
  return buses.some((bus) => {
    if (!hasOppositeFixedWideBus([bus])) return false
    const tangent =
      bus.exitEdge === "left" || bus.exitEdge === "right" ? "y" : "x"
    const tracks = bus.connections.map(
      (connection) => exits.get(connection.connectionIndex)?.[tangent],
    )
    if (tracks.some((track) => track === undefined || !Number.isFinite(track)))
      return false
    const minimum =
      tangent === "x" ? bus.componentBounds.minX : bus.componentBounds.minY
    const maximum =
      tangent === "x" ? bus.componentBounds.maxX : bus.componentBounds.maxY
    // Exits entirely beside the field leave an exterior approach. Preserve
    // the established fixed-via retries there before replacing source sites.
    return (
      Math.min(...(tracks as number[])) <= maximum + 1e-7 &&
      Math.max(...(tracks as number[])) >= minimum - 1e-7
    )
  })
}
