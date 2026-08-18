import { expect, test } from "bun:test"
import { FanoutSolver } from "../lib"

test("FanoutSolver has a stable solver name", () => {
  expect(FanoutSolver.solverName).toBe("FanoutSolver")
})
