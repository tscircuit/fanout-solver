import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createFootprinterBenchmarkSrj } from "tests/fixtures/create-footprinter-benchmark"

test("the solver evaluates bounded combinations of available layers", () => {
  const srj = createFootprinterBenchmarkSrj({ gridSize: 6, layerCount: 4 })
  const solver = new FanoutSolver(srj, { maxLayerCombinations: 5 })
  solver.solve()
  const output = solver.getOutput()

  expect(output.attempts).toHaveLength(5)
  expect(
    new Set(
      output.attempts.map((attempt) =>
        JSON.stringify(attempt.busLayerAssignments),
      ),
    ).size,
  ).toBe(5)
  for (const attempt of output.attempts) {
    expect(
      Object.values(attempt.busLayerAssignments).every((layer) =>
        ["inner1", "inner2", "bottom"].includes(layer),
      ),
    ).toBe(true)
  }
})
