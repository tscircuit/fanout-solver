import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import {
  am62lTopEdgeBreakoutProvenance,
  createAm62lTopEdgeBreakoutRepro,
} from "../repros/repro04-am62l-top-edge-breakout.page"

const expectedSignalExitPositions = {
  DDR_ADDR_CTRL: "topside_center",
  DDR_BYTE0: "topside_left",
  DDR_BYTE1: "topside_right",
  DDR_CLOCK: "topside_left",
  DDR_DMI0: "topside_left",
  DDR_DMI1: "topside_right",
  DDR_DQS0: "topside_left",
  DDR_DQS1: "topside_right",
  DDR_RESET: "topside_center",
} as const

test("captures the AM62L nine-bus top-edge breakout input", async () => {
  const { inputSrj, options } = createAm62lTopEdgeBreakoutRepro()

  expect(am62lTopEdgeBreakoutProvenance).toEqual({
    generator: "scripts/generate-repro/generate-repro04.tsx",
    layout: "ram_above",
  })
  expect(inputSrj.connections).toHaveLength(135)
  expect(inputSrj.obstacles).toHaveLength(589)
  expect(inputSrj.layerCount).toBe(8)
  expect(inputSrj.allowBlindAndBuriedVias).toBe(false)
  expect(inputSrj.allowViaInPad).not.toBe(true)
  expect(options.sharedBoundary).toEqual(inputSrj.bounds)
  expect(options.allowBlindAndBuriedVias).toBe(false)

  const signalBuses = (options.buses ?? []).filter(
    (bus) => bus.termination?.type !== "plane",
  )
  const planeBuses = (options.buses ?? []).filter(
    (bus) => bus.termination?.type === "plane",
  )
  expect(signalBuses).toHaveLength(9)
  expect(planeBuses).toHaveLength(102)
  expect(
    signalBuses.reduce(
      (connectionCount, bus) => connectionCount + bus.connectionNames.length,
      0,
    ),
  ).toBe(33)
  expect(
    Object.fromEntries(signalBuses.map((bus) => [bus.busId, bus.exitPosition])),
  ).toEqual(expectedSignalExitPositions)

  const connectionByName = new Map(
    inputSrj.connections.map((connection) => [connection.name, connection]),
  )
  const signalConnectionNames = new Set(
    signalBuses.flatMap((bus) => bus.connectionNames),
  )
  const signalConnections = inputSrj.connections.filter((connection) =>
    signalConnectionNames.has(connection.name),
  )
  const sourcePoints = signalConnections.flatMap((connection) =>
    connection.pointsToConnect.filter((point) =>
      point.pointId?.startsWith("pcb_port_"),
    ),
  )
  const breakoutTargets = signalConnections.flatMap((connection) =>
    connection.pointsToConnect.filter((point) =>
      point.pointId?.startsWith("pcb_breakout_point_"),
    ),
  )

  expect(sourcePoints).toHaveLength(33)
  expect(breakoutTargets).toHaveLength(33)
  expect(
    sourcePoints.every((point) => point.y < inputSrj.bounds.maxY - 0.0001),
  ).toBe(true)
  expect(
    breakoutTargets.every(
      (point) => Math.abs(point.y - (inputSrj.bounds.maxY - 0.0001)) < 1e-9,
    ),
  ).toBe(true)
  expect(
    breakoutTargets.some(
      (point) => Math.abs(point.x - (inputSrj.bounds.maxX - 0.0001)) < 1e-9,
    ),
  ).toBe(false)

  for (const bus of signalBuses) {
    for (const connectionName of bus.connectionNames) {
      const connection = connectionByName.get(connectionName)
      const breakoutTarget = connection?.pointsToConnect.find((point) =>
        point.pointId?.startsWith("pcb_breakout_point_"),
      )
      const exitTarget = bus.connectionExitTargets?.[connectionName]

      expect(breakoutTarget).toBeDefined()
      expect(exitTarget?.x).toBe(breakoutTarget!.x)
      expect(exitTarget?.y).toBeGreaterThan(inputSrj.bounds.maxY)
    }
  }

  const solver = new FanoutSolver(inputSrj, options)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})
