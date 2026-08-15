import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"
import sample004ControllerFixture from "./fixtures/sample004-controller-track-starvation.json"

const fixture = sample004ControllerFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

test("visual regression: guided tracks stay inside the fanout boundary", async () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 25,
    brokenOutConnectionCount: 25,
    issues: [],
  })

  await expect(
    getPcbSvgFromSrj(fixture.inputSrj, output.simpleRouteJson, {
      deduplicateTraceIds: true,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 120_000)
