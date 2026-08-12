import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  createSrj29FanoutInput,
  SRJ29_FANOUT_LAYER_COUNT,
  srj29FanoutSamples,
} from "../datasets/srj29"

test("SRJ29 exposes independently routed power pins and directional signal buses", () => {
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
  expect(powerBuses).toHaveLength(sample.powerConnectionCount)
  expect(powerBuses?.every((bus) => bus.connectionNames.length === 1)).toBe(
    true,
  )
  expect(
    powerBuses
      ?.filter((bus) => bus.busId.startsWith("power_vcc"))
      .every(
        (bus) =>
          bus.termination?.type === "plane" &&
          bus.termination.layer === "inner2",
      ),
  ).toBe(true)
  expect(
    powerBuses
      ?.filter((bus) => bus.busId.startsWith("power_gnd"))
      .every(
        (bus) =>
          bus.termination?.type === "plane" &&
          bus.termination.layer === "inner3",
      ),
  ).toBe(true)
  expect(powerBuses?.every((bus) => bus.direction !== undefined)).toBe(true)
  expect(
    input.obstacles.some(
      (obstacle) =>
        obstacle.componentId?.startsWith("C") &&
        obstacle.layers.includes(sample.passiveLayer),
    ),
  ).toBe(true)
})

test("SRJ29 VCC and GND pins break out to dedicated planes", () => {
  const sample = srj29FanoutSamples.find(
    (candidate) => candidate.id === "sample093",
  )!
  const solver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
    // This test audits the fanout contract and retained endpoint metadata;
    // endpoint completion has its own DRC/connectivity integration coverage.
    completeOriginalEndpoints: false,
    maxLayerCombinations: 32,
  })
  solver.solve()

  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  const powerConnections = sample.simpleRouteJson.connections.filter(
    (connection) =>
      connection.netConnectionName === "VCC" ||
      connection.netConnectionName === "GND",
  )
  const powerNetNames = new Set(
    powerConnections.map((connection) => connection.netConnectionName),
  )

  expect(powerNetNames).toEqual(new Set(["VCC", "GND"]))
  expect(output.planeTerminations).toHaveLength(powerConnections.length)
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: sample.fanoutConnectionCount,
    brokenOutConnectionCount: sample.fanoutConnectionCount,
    issues: [],
  })

  for (const inputConnection of powerConnections) {
    const outputConnection = output.simpleRouteJson.connections.find(
      (connection) => connection.name === inputConnection.name,
    )
    const planeTermination = output.planeTerminations.find(
      (termination) => termination.connectionName === inputConnection.name,
    )

    expect(outputConnection).toBeUndefined()
    expect(planeTermination?.layer).toBe(
      inputConnection.netConnectionName === "VCC" ? "inner2" : "inner3",
    )
    expect(
      output.fanoutTraces
        .filter((trace) => trace.connection_name === inputConnection.name)
        .flatMap((trace) => trace.route)
        .filter((routePoint) => routePoint.route_type === "via")
        .every((via) =>
          inputConnection.pointsToConnect.every(
            (endpoint) =>
              Math.hypot(via.x - endpoint.x, via.y - endpoint.y) > 1e-6,
          ),
        ),
    ).toBe(true)
  }
})

test("multi-connection SRJ29 buses never duplicate routed connection plans", () => {
  const sample = srj29FanoutSamples.find(
    (candidate) => candidate.id === "sample004",
  )!
  const solver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
    maxLayerCombinations: 8,
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
}, 30_000)
