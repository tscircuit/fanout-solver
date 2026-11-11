import { expect, test } from "bun:test"
import { fitLocalViaGrid } from "../lib/fit-local-via-grid"

test("import rounding does not close a nominal two-trace via channel", () => {
  const pads = [-1.200081, -0.400108, 0.399865, 1.199838],
    original = [...pads]
  const grid = fitLocalViaGrid(pads, 0.0035)!
  expect(pads).toEqual(original)
  expect(grid.coordinates[0]).toBeCloseTo(-1.2, 12)
  const vias = grid.coordinates
    .slice(1)
    .map((x, i) => (x + grid.coordinates[i]!) / 2)
  expect(vias[1]! - vias[0]!).toBeGreaterThanOrEqual(0.8 - 1e-10)
  expect(vias[2]! - vias[1]!).toBeGreaterThanOrEqual(0.8 - 1e-10)
  expect(fitLocalViaGrid([0, 0.8, 1.7], 0.0035)).toBeNull()
})
