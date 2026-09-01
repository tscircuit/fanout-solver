import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"
import capturedFixture from "./fixtures/am62l-frame022-full-soc-fanout-performance-repro.json"

type CapturedFixture = {
  metadata: {
    frameIndex: number
    orbitAngleDegrees: number
    boardWidthMm: number
    boardHeightMm: number
    socFanoutPaddingMm: number
    dramFanoutPaddingMm: number
    dramPosition: { x: number; y: number }
  }
  input: SimpleRouteJson
  options: FanoutSolverOptions
}

const fixture = capturedFixture as unknown as CapturedFixture
const fixturePath = new URL(
  "./fixtures/am62l-frame022-full-soc-fanout-performance-repro.json",
  import.meta.url,
).pathname
const witnessPath = new URL(
  "./helpers/run-complete-fanout-witness.ts",
  import.meta.url,
).pathname

const runBoundedWitness = async (timeoutMs: number) => {
  const child = Bun.spawn([process.execPath, witnessPath, fixturePath], {
    stdout: "ignore",
    stderr: "ignore",
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, timeoutMs)
  try {
    return { exitCode: await child.exited, timedOut }
  } finally {
    clearTimeout(timeout)
    if (timedOut) await child.exited
  }
}

test("captures the exact frame-022 AM62L SoC fanout constructor input", () => {
  const { metadata, input, options } = fixture
  expect(metadata).toMatchObject({
    frameIndex: 22,
    orbitAngleDegrees: 88,
    boardWidthMm: 90,
    boardHeightMm: 90,
    socFanoutPaddingMm: 3,
    dramFanoutPaddingMm: 3,
    dramPosition: {
      x: 1.0469849010750325,
      y: 29.981724810572874,
    },
  })

  expect(input.connections).toHaveLength(135)
  expect(input.obstacles).toHaveLength(589)
  expect(input.traces).toHaveLength(0)
  expect(input.minViaHoleDiameter).toBe(0.15)
  expect(options.escapeLayers).toEqual([
    "top",
    "inner4",
    "inner5",
    "inner6",
    "bottom",
  ])
  expect(options.sharedBoundary).toEqual({
    minX: -8.62808,
    maxX: 8.62808,
    minY: -8.62808,
    maxY: 8.62808,
  })
  expect(options.buses).toHaveLength(111)
  expect(
    options.buses?.filter((bus) => bus.termination?.type === "plane"),
  ).toHaveLength(102)
  expect(
    options.buses
      ?.filter((bus) => bus.termination?.type !== "plane")
      .map((bus) => [bus.busId, bus.connectionNames.length]),
  ).toEqual([
    ["DDR_BYTE0", 8],
    ["DDR_BYTE1", 8],
    ["DDR_ADDR_CTRL", 8],
    ["DDR_CLOCK", 2],
    ["DDR_DQS0", 2],
    ["DDR_DQS1", 2],
    ["DDR_RESET", 1],
    ["DDR_DMI0", 1],
    ["DDR_DMI1", 1],
  ])
})

test("fully routes the frame-022 SoC fanout within sixty seconds", async () => {
  expect(await runBoundedWitness(60_000)).toEqual({
    exitCode: 0,
    timedOut: false,
  })
}, 70_000)
