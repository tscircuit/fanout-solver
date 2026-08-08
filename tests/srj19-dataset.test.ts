import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createSrj19FanoutInput, srj19FanoutSamples } from "../datasets/srj19"

test("SRJ19 adapts all 200 samples into BGA fanout problems", () => {
  expect(srj19FanoutSamples).toHaveLength(200)

  for (const sample of srj19FanoutSamples) {
    expect(sample.fanoutConnectionCount).toBeGreaterThan(0)
    expect(sample.fanoutConnectionCount).toBeLessThanOrEqual(
      sample.sourceConnectionCount,
    )
    expect(sample.simpleRouteJson.connections).toHaveLength(
      sample.fanoutConnectionCount,
    )
    expect(sample.simpleRouteJson.obstacles).toHaveLength(sample.obstacleCount)
    expect(sample.simpleRouteJson.buses).toBeUndefined()
    expect(sample.solverOptions.sourceComponentId).toBe("bga_component")
    expect(sample.solverOptions.sharedBoundary).toEqual(
      sample.simpleRouteJson.bounds,
    )

    const solver = new FanoutSolver(sample.simpleRouteJson, {
      ...sample.solverOptions,
      maxLayerCombinations: 1,
    })
    expect(solver.preparedBuses).toHaveLength(sample.fanoutConnectionCount)
    expect(
      solver.preparedBuses.every((bus) => bus.componentId === "bga_component"),
    ).toBe(true)
  }
})

test("SRJ19 keeps all obstacles and only connections touching the BGA", () => {
  const sample = srj19FanoutSamples[0]!
  const adaptedAgain = createSrj19FanoutInput(sample.simpleRouteJson)

  expect(adaptedAgain.obstacles).toBe(sample.simpleRouteJson.obstacles)
  expect(adaptedAgain.connections).toHaveLength(sample.fanoutConnectionCount)
})
