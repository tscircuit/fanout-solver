import { expect, test } from "bun:test"
import {
  type FanoutExitPosition,
  type FanoutExitPositionConfig,
  getFanoutExitPositionConfig,
} from "lib/index"

test("canonical fanout exit positions resolve to orthogonal routing fields", () => {
  const expectedConfigs = {
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
  } satisfies Record<FanoutExitPosition, FanoutExitPositionConfig>

  for (const exitPosition of Object.keys(
    expectedConfigs,
  ) as FanoutExitPosition[]) {
    expect(getFanoutExitPositionConfig(exitPosition)).toEqual(
      expectedConfigs[exitPosition],
    )
  }
  expect(() =>
    getFanoutExitPositionConfig("right_top" as FanoutExitPosition),
  ).toThrow('Invalid fanout exit position "right_top"')
})
