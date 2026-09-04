import type { FanoutDirection, Point2D } from "./types"

/** A bounded fallback for channels trapped by uniform outward dogbones. */
export function getDogboneSideVariants(
  connections: readonly { connectionIndex: number; sourcePoint: Point2D }[],
  direction: FanoutDirection,
): number[][] {
  const axis = direction === "up" || direction === "down" ? "y" : "x"
  const variants = connections
    .slice(0, 32)
    .map(({ connectionIndex }) => [connectionIndex])
  // Two pads in the same escape row can jointly close a winding corridor.
  // Move both to the other half-pitch row, keeping every other site unchanged.
  // Do not enumerate the exponential Cartesian product of all via sites.
  for (let first = 0; first < connections.length; first++) {
    for (let second = first + 1; second < connections.length; second++) {
      if (variants.length >= 32) return variants
      const a = connections[first]!
      const b = connections[second]!
      if (Math.abs(a.sourcePoint[axis] - b.sourcePoint[axis]) <= 1e-9) {
        variants.push([a.connectionIndex, b.connectionIndex])
      }
    }
  }
  return variants
}
