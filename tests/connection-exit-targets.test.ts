import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { getBoundaryTargetTrack } from "lib/route-bus"
import type { FanoutBusSpec, Point2D } from "lib/types"

const signalPadIndices = [5, 6, 9, 10]

function createBgaObstacles(componentId: string, centerX: number): Obstacle[] {
  return Array.from({ length: 16 }, (_, padIndex) => {
    const pointId = `${componentId}-pad-${padIndex + 1}`
    return {
      obstacleId: pointId,
      componentId,
      type: "rect" as const,
      center: {
        x: centerX + (padIndex % 4) * 0.8 - 1.2,
        y: Math.floor(padIndex / 4) * 0.8 - 1.2,
      },
      width: 0.35,
      height: 0.35,
      layers: ["top"],
      connectedTo: [pointId, `DATA${signalPadIndices.indexOf(padIndex)}`],
    }
  })
}

test("connection exit targets align a breakout with its paired fanout", async () => {
  const leftPads = createBgaObstacles("left-bga", -4)
  const rightPads = createBgaObstacles("right-bga", 4)
  const desiredExitTargets: Record<string, Point2D> = {
    DATA0: { x: 1, y: -0.6 },
    DATA1: { x: 1, y: -0.2 },
    DATA2: { x: 1, y: 0.4 },
    DATA3: { x: 1, y: 0.6 },
  }
  const bus: FanoutBusSpec = {
    busId: "DATA_BUS",
    connectionNames: Object.keys(desiredExitTargets),
    sourceComponentId: "left-bga",
    direction: "right",
    connectionExitTargets: desiredExitTargets,
  }
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -8, maxX: 6, minY: -4, maxY: 4 },
    obstacles: [...leftPads, ...rightPads],
    connections: signalPadIndices.map((padIndex, connectionIndex) => {
      const sourcePad = leftPads[padIndex]!
      const targetPad = rightPads[padIndex]!
      return {
        name: `DATA${connectionIndex}`,
        pointsToConnect: [
          {
            ...sourcePad.center,
            layer: "top",
            pointId: sourcePad.obstacleId,
          },
          {
            ...targetPad.center,
            layer: "top",
            pointId: targetPad.obstacleId,
          },
        ],
      }
    }),
    buses: [bus],
  }

  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary: { minX: -7, maxX: -1, minY: -3, maxY: 3 },
    escapeLayers: ["top", "bottom"],
    compactBusTracks: true,
    borderDistribution: "even",
  })
  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation.valid).toBe(true)

  const exitYByConnection: Record<string, number> = {}
  for (const trace of output.fanoutTraces) {
    const exit = trace.route.at(-1)
    const target = desiredExitTargets[trace.connection_name]
    expect(exit?.route_type).toBe("wire")
    if (exit?.route_type !== "wire" || !target) continue
    expect(exit.x).toBeCloseTo(-1)
    expect(Math.abs(exit.y)).toBeLessThanOrEqual(0.6)
    exitYByConnection[trace.connection_name] = exit.y
  }
  expect(exitYByConnection).toEqual(
    Object.fromEntries(
      Object.entries(desiredExitTargets).map(([connectionName, point]) => [
        connectionName,
        point.y,
      ]),
    ),
  )

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
    "paired-fanout-exit-targets",
  )
})

test("explicit exit targets clamp to the perpendicular boundary span", () => {
  const leftPads = createBgaObstacles("left-bga", -4)
  const rightPads = createBgaObstacles("right-bga", 4)
  const bus: FanoutBusSpec = {
    busId: "DATA_BUS",
    connectionNames: ["DATA0"],
    sourceComponentId: "left-bga",
    direction: "right",
    connectionExitTargets: {
      DATA0: { x: 2, y: -3.2, layer: "bottom" },
    },
  }
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -8, maxX: 6, minY: -4, maxY: 4 },
    obstacles: [...leftPads, ...rightPads],
    connections: [
      {
        name: "DATA0",
        pointsToConnect: [
          {
            ...leftPads[signalPadIndices[0]!]!.center,
            layer: "top",
            pointId: leftPads[signalPadIndices[0]!]!.obstacleId,
          },
          {
            ...rightPads[signalPadIndices[0]!]!.center,
            layer: "top",
            pointId: rightPads[signalPadIndices[0]!]!.obstacleId,
          },
        ],
      },
    ],
    buses: [bus],
  }

  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary: { minX: -7, maxX: -1, minY: -3, maxY: 3 },
    escapeLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
  })

  expect(solver.preparedBuses[0]?.sharedBoundary).toEqual({
    minX: -7,
    maxX: -1,
    minY: -3,
    maxY: 3,
  })
  const preparedBus = solver.preparedBuses[0]
  const preparedConnection = preparedBus?.connections[0]
  if (!preparedBus || !preparedConnection) {
    throw new Error("Missing prepared DATA0 connection")
  }
  expect(
    getBoundaryTargetTrack({
      bus: preparedBus,
      connection: preparedConnection,
      boundaryDirection: "right",
    }),
  ).toBe(-3)
  solver.solve()
  expect(solver.failed).toBe(false)
  expect(solver.getOutput().validation.valid).toBe(true)
})
