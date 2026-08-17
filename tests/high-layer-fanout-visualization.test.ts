import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import sample004ControllerFixture from "./fixtures/sample004-controller-track-starvation.json"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

const fixture = sample004ControllerFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

test("an 18-layer DDR3 fanout renders every routed copper layer", async () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const graphics = solver.visualize()
  await expect(
    getPcbSvgFromSrj(fixture.inputSrj, solver.getOutputSimpleRouteJson(), {
      deduplicateTraceIds: true,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
    "debugger",
  )
}, 120_000)
