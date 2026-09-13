import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { benchmarkSamples } from "../benchmarks/benchmark-catalog"
import { FanoutSolver } from "../lib/fanout-solver"
import { createDataset31Sample } from "../scripts/generate-repro/create-dataset31-sample"

test("shows dataset 31 sample 59 while the native router is still running", async () => {
  const definition = benchmarkSamples[58]!
  expect(definition.id).toBe("59-t113s3-left-center")
  const sample = await createDataset31Sample(definition)
  const solver = new FanoutSolver(
    structuredClone(sample.simpleRouteJson),
    structuredClone(sample.solverOptions),
  )

  let nativeRouter = solver.activeSubSolver
  for (let step = 0; step < 10; step++) {
    solver.step()
    nativeRouter =
      solver.activeSubSolver?.activeSubSolver?.activeSubSolver ?? nativeRouter
    if ((nativeRouter?.iterations ?? 0) > 0) break
  }

  expect(solver.solved).toBe(false)
  if (!nativeRouter) throw new Error("Sample 59 did not start a native router")
  expect(nativeRouter.getSolverName()).toBe("HighDensitySolverA03")
  const visualization = solver.visualize()
  expect(visualization).toEqual(nativeRouter.visualize())
  expect(visualization.lines?.length).toBeGreaterThan(0)
  await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
