import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { srj19FanoutSamples } from "../datasets/srj19"

const sample = srj19FanoutSamples.find(({ id }) => id === "sample064")
if (!sample) throw new Error("SRJ19 sample064 is missing")

test("SRJ19 sample064 solves on six layers", async () => {
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.getOutput().fanoutTraces).toHaveLength(
    sample.fanoutConnectionCount,
  )
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
    "six-layer-fanout",
  )
}, 30_000)
