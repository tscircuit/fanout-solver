import type { FanoutExitPosition, FanoutExitPositionConfig } from "./types"

const FANOUT_EXIT_POSITION_CONFIGS: Readonly<
  Record<FanoutExitPosition, Readonly<FanoutExitPositionConfig>>
> = {
  topside_left: {
    direction: "left",
    preferredExit: "top-left",
    exitEdge: "top",
  },
  topside_center: {
    direction: "up",
    preferredExit: "top",
    exitEdge: "top",
  },
  topside_right: {
    direction: "right",
    preferredExit: "top-right",
    exitEdge: "top",
  },
  rightside_top: {
    direction: "up",
    preferredExit: "top-right",
    exitEdge: "right",
  },
  rightside_center: {
    direction: "right",
    preferredExit: "right",
    exitEdge: "right",
  },
  rightside_bottom: {
    direction: "down",
    preferredExit: "bottom-right",
    exitEdge: "right",
  },
  bottomside_right: {
    direction: "right",
    preferredExit: "bottom-right",
    exitEdge: "bottom",
  },
  bottomside_center: {
    direction: "down",
    preferredExit: "bottom",
    exitEdge: "bottom",
  },
  bottomside_left: {
    direction: "left",
    preferredExit: "bottom-left",
    exitEdge: "bottom",
  },
  leftside_bottom: {
    direction: "down",
    preferredExit: "bottom-left",
    exitEdge: "left",
  },
  leftside_center: {
    direction: "left",
    preferredExit: "left",
    exitEdge: "left",
  },
  leftside_top: {
    direction: "up",
    preferredExit: "top-left",
    exitEdge: "left",
  },
  center: {},
}

/** Resolves a canonical exit position into the solver's orthogonal fields. */
export function getFanoutExitPositionConfig(
  exitPosition: FanoutExitPosition,
): Readonly<FanoutExitPositionConfig> {
  const config = FANOUT_EXIT_POSITION_CONFIGS[exitPosition]
  if (!config) {
    throw new Error(`Invalid fanout exit position "${exitPosition}"`)
  }
  return config
}
