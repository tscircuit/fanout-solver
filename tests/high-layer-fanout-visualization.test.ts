import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import sample004ControllerFixture from "./fixtures/sample004-controller-track-starvation.json"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

const fixture = sample004ControllerFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

test("repro: an 18-layer DDR3 fanout solves but its debugger cannot render inner10", async () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(() => solver.visualize()).toThrow(
    'No visualization color for layer "inner10"',
  )
  await expect(
    getPcbSvgFromSrj(fixture.inputSrj, solver.getOutputSimpleRouteJson(), {
      deduplicateTraceIds: true,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 120_000)
