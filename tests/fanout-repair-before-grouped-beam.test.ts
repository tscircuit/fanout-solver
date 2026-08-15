import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { srj19FanoutSamples } from "../datasets/srj19"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

const sample = srj19FanoutSamples.find(({ id }) => id === "sample002")
if (!sample) throw new Error("SRJ19 sample002 is missing")

test("visual repro: targeted repair misses a bounded assignment budget", async () => {
  const boundedSolver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
    maxLayerCombinations: 17,
  })
  boundedSolver.solve()

  expect(boundedSolver.solved).toBe(false)
  expect(boundedSolver.failed).toBe(true)
  expect(boundedSolver.attempts).toHaveLength(17)
  expect(
    Math.max(
      ...boundedSolver.attempts.map((attempt) => attempt.routedConnectionCount),
    ),
  ).toBe(14)

  const completedSolver = new FanoutSolver(
    sample.simpleRouteJson,
    sample.solverOptions,
  )
  completedSolver.solve()

  expect(completedSolver.solved).toBe(true)
  expect(completedSolver.attempts).toHaveLength(35)

  await expect(
    getPcbSvgFromSrj(
      sample.simpleRouteJson,
      completedSolver.getOutputSimpleRouteJson(),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
