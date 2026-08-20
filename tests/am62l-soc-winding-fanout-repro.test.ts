import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import inputJson from "./fixtures/am62l-soc-winding-fanout.json"

const input = inputJson as unknown as {
  simpleRouteJson: SimpleRouteJson
  options: FanoutSolverOptions
}

test.failing("routes the captured AM62L winding fanout", () => {
  const solver = new FanoutSolver(input.simpleRouteJson, input.options)
  solver.solve()
  expect(solver.solved).toBe(true)
})
