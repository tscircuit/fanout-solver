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
      .every((bus) => bus.direction === "left"),
  ).toBe(true)
  expect(
    powerBuses
      ?.filter((bus) => bus.busId.startsWith("power_gnd"))
      .every((bus) => bus.direction === "right"),
  ).toBe(true)
  expect(powerBuses?.every((bus) => bus.termination?.type === "boundary")).toBe(
    true,
  )
  expect(
    input.obstacles.some(
      (obstacle) =>
        obstacle.componentId?.startsWith("C") &&
        obstacle.layers.includes(sample.passiveLayer),
    ),
  ).toBe(true)
})

test("SRJ29 VCC and GND pins are validated boundary breakouts with capacitor endpoints retained", () => {
  const sample = srj29FanoutSamples.find(
    (candidate) => candidate.id === "sample093",
  )!
  const solver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
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
  expect(output.planeTerminations).toHaveLength(0)
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: sample.fanoutConnectionCount,
    brokenOutConnectionCount: sample.fanoutConnectionCount,
    issues: [],
  })

  for (const inputConnection of powerConnections) {
    const preparedConnection = solver.preparedBuses
      .flatMap((bus) => bus.connections)
      .find(
        (connection) => connection.connection.name === inputConnection.name,
      )!
    const outputConnection = output.simpleRouteJson.connections.find(
      (connection) => connection.name === inputConnection.name,
    )
    const trace = output.fanoutTraces.find(
      (candidate) => candidate.connection_name === inputConnection.name,
    )!
    const traceEnd = [...trace.route]
      .reverse()
      .find((routePoint) => "x" in routePoint && "y" in routePoint)!
    const outputExit =
      outputConnection?.pointsToConnect[preparedConnection.sourcePointIndex]

    expect(outputConnection).toBeDefined()
    expect(outputExit).toMatchObject({
      x: traceEnd.x,
      y: traceEnd.y,
    })
    expect(
      inputConnection.pointsToConnect
        .filter(
          (_, pointIndex) => pointIndex !== preparedConnection.sourcePointIndex,
        )
        .every((capacitorPoint) =>
          outputConnection!.pointsToConnect.some(
            (point) =>
              point.pointId === capacitorPoint.pointId &&
              point.pcb_port_id === capacitorPoint.pcb_port_id,
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
