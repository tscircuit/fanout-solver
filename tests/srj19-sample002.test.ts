import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { srj19FanoutSamples } from "../datasets/srj19"

const sample = srj19FanoutSamples.find(({ id }) => id === "sample002")
if (!sample) throw new Error("SRJ19 sample002 is missing")

test("SRJ19 sample002 solves on six layers", async () => {
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)

  expect(
    solver.layerAssignments.every(
      (assignment) =>
        assignment["connection:bga_conn_007"] !== "top" &&
        assignment["connection:bga_conn_007"] !== "bottom",
    ),
  ).toBe(true)

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
