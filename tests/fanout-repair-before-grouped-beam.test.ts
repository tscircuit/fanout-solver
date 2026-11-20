import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { srj19FanoutSamples } from "../datasets/srj19"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

const sample = srj19FanoutSamples.find(({ id }) => id === "sample002")
if (!sample) throw new Error("SRJ19 sample002 is missing")

test("routes sample002 within the configured assignment budget", async () => {
  const solver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
    maxLayerCombinations: 17,
  })
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.attempts.length).toBeLessThanOrEqual(17)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: sample.fanoutConnectionCount,
    brokenOutConnectionCount: sample.fanoutConnectionCount,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: sample.simpleRouteJson,
      routedSrj: output.simpleRouteJson,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: solver.config.allowBlindAndBuriedVias,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  await expect(
    getPcbSvgFromSrj(sample.simpleRouteJson, output.simpleRouteJson),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
