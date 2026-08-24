import type { FanoutBorderTarget, FanoutDirection, FanoutEdge } from "./types"

export function getExitEdgeForDirection(
  direction: FanoutDirection,
): FanoutEdge {
  switch (direction) {
    case "left":
      return "left"
    case "right":
      return "right"
    case "up":
      return "top"
    case "down":
      return "bottom"
  }
}

export function getDirectionForExitEdge(exitEdge: FanoutEdge): FanoutDirection {
  switch (exitEdge) {
    case "left":
      return "left"
    case "right":
      return "right"
    case "top":
      return "up"
    case "bottom":
      return "down"
  }
}

export function borderTargetIncludesEdge(
  preferredExit: FanoutBorderTarget,
  exitEdge: FanoutEdge,
): boolean {
  return preferredExit === exitEdge || preferredExit.includes(exitEdge)
}

/**
 * Returns the lower/left or upper/right band selected along an explicit edge.
 * Edge-center targets do not select a corner band.
 */
export function getCornerBandSide(
  exitEdge: FanoutEdge | undefined,
  preferredExit: FanoutBorderTarget | undefined,
): "minimum" | "maximum" | undefined {
  if (!exitEdge || !preferredExit?.includes("-")) return undefined
  if (!borderTargetIncludesEdge(preferredExit, exitEdge)) return undefined
  if (exitEdge === "left" || exitEdge === "right") {
    return preferredExit.startsWith("top-") ? "maximum" : "minimum"
  }
  return preferredExit.endsWith("-right") ? "maximum" : "minimum"
}
