import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  createSrj29FanoutInput,
  SRJ29_FANOUT_LAYER_COUNT,
  srj29FanoutSamples,
} from "../datasets/srj29"

test("SRJ29 exposes paired power nets and directional signal buses", () => {
  expect(srj29FanoutSamples).toHaveLength(200)

  const sample = srj29FanoutSamples[0]!
  const input = createSrj29FanoutInput(sample.simpleRouteJson)
  const powerConnections = input.connections.filter(
    (connection) =>
      connection.netConnectionName === "VCC" ||
      connection.netConnectionName === "GND",
  )
  const powerBuses = sample.solverOptions.buses?.filter((bus) =>
    bus.busId.startsWith("power_"),
  )

  expect(input.layerCount).toBe(SRJ29_FANOUT_LAYER_COUNT)
  expect(powerConnections).toHaveLength(sample.powerConnectionCount)
  expect(powerBuses).toHaveLength(2)
  expect(powerBuses?.every((bus) => bus.connectionNames.length > 1)).toBe(true)
  expect(
    input.obstacles.some(
      (obstacle) =>
        obstacle.componentId?.startsWith("C") &&
        obstacle.layers.includes(sample.passiveLayer),
    ),
  ).toBe(true)
})

test("multi-connection SRJ29 buses never duplicate routed connection plans", () => {
  const sample = srj29FanoutSamples.find(
    (candidate) => candidate.id === "sample004",
  )!
  const solver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
    maxLayerCombinations: 64,
  })
  solver.solve()

  expect(solver.preparedBuses.some((bus) => bus.connections.length > 1)).toBe(
    true,
  )
  expect(
    solver.attempts.every(
      (attempt) =>
        attempt.routedConnectionCount <= sample.fanoutConnectionCount,
    ),
  ).toBe(true)
})
