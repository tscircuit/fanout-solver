import { distanceSegmentToSegment } from "./geometry"
import type { Point2D } from "./types"

/** Dense crossings predict long detours when a whole group shares one layer. */
export function sourceTransitHasMajorityCrossings(
  paths: readonly { source: Point2D; target: Point2D }[],
): boolean {
  const pairs = (paths.length * (paths.length - 1)) / 2
  if (pairs === 0) return false
  let crossings = 0
  for (let i = 0; i < paths.length; i++) {
    const first = paths[i]!
    for (const second of paths.slice(i + 1))
      if (
        distanceSegmentToSegment(
          first.source,
          first.target,
          second.source,
          second.target,
        ) < 1e-7 &&
        ++crossings > pairs / 2
      )
        return true
  }
  return false
}
