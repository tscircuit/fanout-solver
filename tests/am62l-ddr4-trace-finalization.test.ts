import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"

interface CapturedFixture {
  generatedFrom: {
    repository: string
    integrationCommit: string
    source: string
    capture: string
  }
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}

const fixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL(
        "./fixtures/am62l-ddr4-trace-finalization.json.gz",
        import.meta.url,
      ),
    ),
  ).toString("utf8"),
) as CapturedFixture

test("finalizes the exact AM62L DDR4 clock escape", async () => {
  expect(fixture.generatedFrom).toEqual({
    repository: "https://github.com/tscircuit/core",
    integrationCommit: "9107d743",
    source: "tests/fixtures/am62l-ddr4-real/index.circuit.tsx",
    capture:
      "second FanoutSolver constructor, reduced only to the exact DDR_CLOCK and DDR_ADDR_SOUTH_MID_1_2 signals that expose trace finalization",
  })
  expect(fixture.simpleRouteJson.connections).toHaveLength(3)
  expect(fixture.simpleRouteJson.obstacles).toHaveLength(469)
  expect(fixture.solverOptions.buses?.map((bus) => bus.busId)).toEqual([
    "DDR_CLOCK",
    "DDR_ADDR_SOUTH_MID_1_2",
  ])

  const solver = new FanoutSolver(
    structuredClone(fixture.simpleRouteJson),
    structuredClone(fixture.solverOptions),
  )
  solver.solve()

  const routedCount = solver.solved ? solver.getOutput().fanoutTraces.length : 0
  const visualization = mergeGraphics(solver.visualize(), {
    texts: [
      {
        x: fixture.simpleRouteJson.bounds.minX,
        y: fixture.simpleRouteJson.bounds.maxY + 1,
        text: `Exact AM62L DDR4 · solved=${solver.solved} · routed=${routedCount}/3`,
        color: solver.solved ? "#166534" : "#b91c1c",
        fontSize: 0.5,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
    import.meta.path,
  )

  expect(solver.failed, solver.error ?? undefined).toBe(false)
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(3)
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
})
