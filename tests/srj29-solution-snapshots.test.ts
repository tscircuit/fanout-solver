import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { srj29FanoutSamples } from "../datasets/srj29"

const PASSING_SAMPLE_IDS = ["sample001", "sample005", "sample009"] as const

for (const sampleId of PASSING_SAMPLE_IDS) {
  test(`SRJ29 ${sampleId} validated fanout solution`, async () => {
    const sample = srj29FanoutSamples.find(({ id }) => id === sampleId)
    if (!sample) throw new Error(`SRJ29 ${sampleId} is missing`)

    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    solver.solve()

    expect(solver.solved).toBe(true)
    expect(solver.failed).toBe(false)
    expect(solver.getOutput().validation).toMatchObject({
      valid: true,
      checkedConnectionCount: sample.fanoutConnectionCount,
      brokenOutConnectionCount: sample.fanoutConnectionCount,
      issues: [],
    })
    await expect(
      getSvgFromGraphicsObject(solver.visualize()),
    ).toMatchSvgSnapshot(import.meta.path, `${sampleId}-validated-fanout`)
  }, 90_000)
}
