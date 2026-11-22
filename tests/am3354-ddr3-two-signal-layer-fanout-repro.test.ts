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

test("breaks out the AM3354 DDR3 balls on two signal layers", async () => {
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

  // The two outer ball columns fit on top, so the three inner columns share
  // the bottom layer. Their target-aligned tracks cannot coexist in the
  // channel beside each column; they leave side by side on source-aligned
  // tracks instead.
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation.valid).toBe(true)
  expect(output.fanoutTraces).toHaveLength(50)
  expect(output.busLayerAssignments).toEqual({
    DDR_BALL_COLUMN_1: "top",
    DDR_BALL_COLUMN_2: "top",
    DDR_BALL_COLUMN_3: "bottom",
    DDR_BALL_COLUMN_4: "bottom",
    DDR_BALL_COLUMN_5: "bottom",
  })
  // Every signal ends on the shared boundary edge facing the memory.
  const boundaryX = solverOptions.sharedBoundary!.minX
  for (const trace of output.fanoutTraces) {
    const exit = trace.route.at(-1)!
    expect(exit.x).toBeCloseTo(boundaryX, 6)
  }
  // The inner layers stay free of signal copper.
  expect(
    output.fanoutTraces.every((trace) =>
      trace.route.every(
        (point) =>
          point.route_type !== "wire" ||
          point.layer === "top" ||
          point.layer === "bottom",
      ),
    ),
  ).toBe(true)

  await expect(
    getSvgFromGraphicsObject(solver.visualizeFanoutRegion()),
  ).toMatchSvgSnapshot(import.meta.path)
})
