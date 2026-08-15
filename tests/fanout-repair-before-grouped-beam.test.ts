import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { srj19FanoutSamples } from "../datasets/srj19"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

const sample = srj19FanoutSamples.find(({ id }) => id === "sample064")
if (!sample) throw new Error("SRJ19 sample064 is missing")

test("visual repro: grouped beam runs before targeted fanout repair", async () => {
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()

  const firstAssignmentIndex = solver.attempts[0]?.assignmentIndex
  expect(firstAssignmentIndex).toBe(-1)

  await expect(
    getPcbSvgFromSrj(sample.simpleRouteJson, solver.getOutputSimpleRouteJson()),
  ).toMatchSvgSnapshot(import.meta.path)
}, 30_000)
