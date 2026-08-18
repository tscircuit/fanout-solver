import { expect, test } from "bun:test"
import { FanoutSolver } from "../lib"

test("FanoutSolver has a stable solver name", () => {
  const solver = Object.create(FanoutSolver.prototype) as FanoutSolver

  expect(solver.getSolverName()).toBe("FanoutSolver")
})
