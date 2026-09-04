import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { srj19FanoutSamples } from "../datasets/srj19"

const sample = srj19FanoutSamples.find(({ id }) => id === "sample017")
if (!sample) throw new Error("SRJ19 sample017 is missing")

test("SRJ19 sample017 recovers a blocked singleton with the default budget", async () => {
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.attempts.length).toBeLessThanOrEqual(
    sample.solverOptions.maxLayerCombinations!,
  )
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 20,
    brokenOutConnectionCount: 20,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: sample.simpleRouteJson,
      routedSrj: output.simpleRouteJson,
      clearance: solver.config.clearance,
    }).valid,
  ).toBe(true)

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
    "six-layer-fanout",
  )
}, 60_000)
