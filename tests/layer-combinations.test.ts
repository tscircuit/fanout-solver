import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createFootprinterBenchmarkSrj } from "../datasets/create-footprinter-benchmark"

test("the solver evaluates bounded combinations of available layers", () => {
  const srj = createFootprinterBenchmarkSrj({ gridSize: 6, layerCount: 4 })
  const solver = new FanoutSolver(srj, { maxLayerCombinations: 5 })
  solver.solve()
  const output = solver.getOutput()

  expect(solver.layerAssignments).toHaveLength(5)
  expect(
    new Set(
      solver.layerAssignments.map((assignment) => JSON.stringify(assignment)),
    ).size,
  ).toBe(5)
  expect(output.attempts.length).toBeGreaterThan(0)
  expect(output.attempts.length).toBeLessThanOrEqual(5)
  for (const assignment of solver.layerAssignments) {
    expect(
      Object.values(assignment).every((layer) =>
        ["inner1", "inner2", "bottom"].includes(layer),
      ),
    ).toBe(true)
  }
})
