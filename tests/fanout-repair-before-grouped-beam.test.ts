import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { srj19FanoutSamples } from "../datasets/srj19"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

const sample = srj19FanoutSamples.find(({ id }) => id === "sample002")
if (!sample) throw new Error("SRJ19 sample002 is missing")

test("visual regression: targeted repair solves a bounded assignment budget", async () => {
  const solver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
    maxLayerCombinations: 17,
  })
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.attempts).toHaveLength(17)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: sample.fanoutConnectionCount,
    brokenOutConnectionCount: sample.fanoutConnectionCount,
    issues: [],
  })

  await expect(
    getPcbSvgFromSrj(sample.simpleRouteJson, output.simpleRouteJson),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
