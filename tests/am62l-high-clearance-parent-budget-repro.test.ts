import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import captured from "./fixtures/am62l-core-progressive-fanout.json"

const PREVIOUS_PARENT_ITERATION_LIMIT = 10_000

test("continues an active AM62L high-clearance search past the old parent limit", async () => {
  const inputSrj = {
    ...captured.inputSrj,
    obstacles: captured.inputSrj.obstacles.map(
      ({ connectedToSuffixIndex, ...obstacle }) => ({
        ...obstacle,
        connectedTo: [
          ...obstacle.connectedTo,
          ...(connectedToSuffixIndex === null
            ? []
            : captured.connectedToSuffixes[connectedToSuffixIndex]!),
        ],
      }),
    ),
  } as unknown as ConstructorParameters<typeof FanoutSolver>[0]
  const solver = new FanoutSolver(inputSrj, {
    ...(captured.options as unknown as NonNullable<
      ConstructorParameters<typeof FanoutSolver>[1]
    >),
    clearance: 0.1,
    maxLayerCombinations: 1,
  })

  for (
    let iteration = 0;
    iteration < PREVIOUS_PARENT_ITERATION_LIMIT;
    iteration++
  ) {
    solver.step()
  }

  expect(solver.MAX_ITERATIONS).toBeGreaterThan(PREVIOUS_PARENT_ITERATION_LIMIT)
  expect(solver.failed).toBe(false)
  expect(solver.solved).toBe(false)
  expect(solver.error).toBeNull()
  expect(solver.activeSubSolver?.failed).toBe(false)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 120_000)
