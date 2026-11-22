import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"

interface CapturedFixture {
  description: string
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}

const fixture: CapturedFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/am3354-ddr3-two-signal-layers.json", import.meta.url),
    "utf8",
  ),
)

test("reproduces the AM3354 DDR3 breakout failing on two signal layers", async () => {
  const { simpleRouteJson, solverOptions } = fixture
  expect(simpleRouteJson.layerCount).toBe(4)
  expect(simpleRouteJson.obstacles).toHaveLength(324)
  expect(simpleRouteJson.connections).toHaveLength(50)
  expect(Reflect.get(simpleRouteJson, "allowBlindAndBuriedVias")).toBe(false)
  expect(Reflect.get(simpleRouteJson, "allowViaInPad")).not.toBe(true)
  // The inner layers are reference planes; only the outer layers carry signals.
  expect(solverOptions.escapeLayers).toEqual(["top", "bottom"])
  expect(
    solverOptions.buses?.map((bus) => [
      bus.busId,
      bus.connectionNames.length,
      bus.direction,
    ]),
  ).toEqual([
    ["DDR_BALL_COLUMN_1", 13, "left"],
    ["DDR_BALL_COLUMN_2", 13, "left"],
    ["DDR_BALL_COLUMN_3", 12, "left"],
    ["DDR_BALL_COLUMN_4", 11, "left"],
    ["DDR_BALL_COLUMN_5", 1, "left"],
  ])

  const solver = new FanoutSolver(
    structuredClone(simpleRouteJson),
    structuredClone(solverOptions),
  )
  solver.solve()

  // The two outer ball columns fit on top, so the three inner columns have to
  // share the bottom layer. The third column is never offered the bottom
  // layer: its target-aligned tracks all funnel through the one channel beside
  // the column, so the bus cannot route there even on an empty layer.
  expect(solver.solved).toBe(false)
  expect(solver.error).toBe(
    "FanoutSolver: best layer assignment routed 38/50 connections",
  )
  expect(
    solver.attempts.every(
      (attempt) => attempt.busLayerAssignments.DDR_BALL_COLUMN_3 === "top",
    ),
  ).toBe(true)
  expect(
    solver.attempts.every((attempt) => attempt.failedBusIds.length > 0),
  ).toBe(true)

  await expect(
    getSvgFromGraphicsObject(solver.visualizeFanoutRegion()),
  ).toMatchSvgSnapshot(import.meta.path)
})
