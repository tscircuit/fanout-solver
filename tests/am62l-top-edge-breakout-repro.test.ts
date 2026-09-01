import { expect, test } from "bun:test"
import { createAm62lTopEdgeBreakoutRepro } from "../repros/repro04-am62l-top-edge-breakout.page"

const expectedSignalExitPositions = {
  DDR_ADDR_CTRL: "topside_center",
  DDR_BYTE0: "topside_left",
  DDR_BYTE1: "topside_right",
  DDR_CLOCK: "topside_left",
  DDR_DMI0: "topside_left",
  DDR_DMI1: "topside_right",
  DDR_DQS0: "topside_left",
  DDR_DQS1: "topside_right",
  DDR_RESET: "topside_center",
} as const

test("captures the AM62L nine-bus top-edge breakout input", () => {
  const { inputSrj, options } = createAm62lTopEdgeBreakoutRepro()

  expect(inputSrj.connections).toHaveLength(135)
  expect(inputSrj.obstacles).toHaveLength(373)
  expect(inputSrj.layerCount).toBe(8)
  expect(inputSrj.allowBlindAndBuriedVias).toBe(false)
  expect(inputSrj.allowViaInPad).not.toBe(true)
  expect(options.sharedBoundary).toEqual(inputSrj.bounds)
  expect(options.allowBlindAndBuriedVias).toBe(false)

  const signalBuses = (options.buses ?? []).filter(
    (bus) => bus.termination?.type !== "plane",
  )
  const planeBuses = (options.buses ?? []).filter(
    (bus) => bus.termination?.type === "plane",
  )
  expect(signalBuses).toHaveLength(9)
  expect(planeBuses).toHaveLength(102)
  expect(
    signalBuses.reduce(
      (connectionCount, bus) => connectionCount + bus.connectionNames.length,
      0,
    ),
  ).toBe(33)
  expect(
    Object.fromEntries(signalBuses.map((bus) => [bus.busId, bus.exitPosition])),
  ).toEqual(expectedSignalExitPositions)
})
