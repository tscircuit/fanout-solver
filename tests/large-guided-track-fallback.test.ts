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

type BestAttemptInspection = {
  bestAttempt?: {
    outputSrj: SimpleRouteJson
    summary: { routedConnectionCount: number }
  }
}

test("visual repro: out-of-bound guidance starves legal fanout tracks", async () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  solver.solve()

  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.stats).toMatchObject({
    routedConnections: "23/25",
  })

  const bestAttempt = (solver as unknown as BestAttemptInspection).bestAttempt
  expect(bestAttempt?.summary.routedConnectionCount).toBe(23)

  await expect(
    getPcbSvgFromSrj(fixture.inputSrj, bestAttempt!.outputSrj, {
      deduplicateTraceIds: true,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 120_000)
