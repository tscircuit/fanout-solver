import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

const simpleRouteJson: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  nominalTraceWidth: 0.1,
  minViaPadDiameter: 0.3,
  minViaHoleDiameter: 0.15,
  minTraceToPadEdgeClearance: 0.1,
  minViaEdgeToPadEdgeClearance: 0.1,
  defaultObstacleMargin: 0.1,
  bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
  obstacles: [-0.35, 0.35].flatMap((x, column) =>
    [-0.35, 0.35].map((y, row) => {
      const pointId = `soc-pad-${column}-${row}`
      return {
        obstacleId: pointId,
        componentId: "soc",
        type: "rect" as const,
        center: { x, y },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [
          pointId,
          ...(column === 1 && row === 1 ? ["SIGNAL"] : []),
        ],
      }
    }),
  ),
  connections: [
    {
      name: "SIGNAL",
      pointsToConnect: [
        { x: 0.35, y: 0.35, layer: "top", pointId: "soc-pad-1-1" },
        { x: 2, y: 2, layer: "top" },
      ],
    },
  ],
}

const baseBus: FanoutBusSpec = {
  busId: "BUS",
  connectionNames: ["SIGNAL"],
  sourceComponentId: "soc",
}

function createCapacityFixture(connectionCount: number): {
  srj: SimpleRouteJson
  bus: FanoutBusSpec
} {
  const xCoordinates = Array.from(
    { length: connectionCount },
    (_, index) => (index - (connectionCount - 1) / 2) * 0.7,
  )
  const names = xCoordinates.map((_, index) => `CAPACITY_${index}`)
  const obstacles = xCoordinates.flatMap((x, column) =>
    [-0.35, 0.35].map((y, row) => {
      const pointId = `capacity-pad-${column}-${row}`
      return {
        obstacleId: pointId,
        componentId: "capacity-soc",
        type: "rect" as const,
        center: { x, y },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [pointId, ...(row === 1 ? [names[column]!] : [])],
      }
    }),
  )
  const connections = names.map((name, column) => ({
    name,
    pointsToConnect: [
      {
        x: xCoordinates[column]!,
        y: 0.35,
        layer: "top" as const,
        pointId: `capacity-pad-${column}-1`,
      },
      { x: 2, y: 0, layer: "bottom" as const },
    ],
  }))
  return {
    srj: {
      ...simpleRouteJson,
      obstacles,
      connections,
    },
    bus: {
      busId: "CAPACITY",
      connectionNames: names,
      sourceComponentId: "capacity-soc",
      direction: "up",
      preferredExit: "top-right",
      exitEdge: "right",
    },
  }
}

test("independent boundary-edge routing is opt-in and validates its geometry", () => {
  expect(
    () =>
      new FanoutSolver(simpleRouteJson, {
        buses: [
          {
            ...baseBus,
            exitEdge: "right",
          },
        ],
      }),
  ).toThrow("exitEdge requires preferredExit")

  expect(
    () =>
      new FanoutSolver(simpleRouteJson, {
        buses: [
          {
            ...baseBus,
            direction: "up",
            preferredExit: "top-right",
            exitEdge: "bottom",
          },
        ],
      }),
  ).toThrow('exitEdge "bottom" is incompatible with preferredExit "top-right"')

  const guidedCornerSolver = new FanoutSolver(simpleRouteJson, {
    buses: [
      {
        ...baseBus,
        direction: "up",
        preferredExit: "top-right",
      },
    ],
  })
  expect(guidedCornerSolver.preparedBuses[0]?.exitEdge).toBeUndefined()

  const independentEdgeSolver = new FanoutSolver(simpleRouteJson, {
    buses: [
      {
        ...baseBus,
        direction: "up",
        preferredExit: "top-right",
        exitEdge: "right",
      },
    ],
  })
  expect(independentEdgeSolver.preparedBuses[0]?.direction).toBe("up")
  expect(independentEdgeSolver.preparedBuses[0]?.exitEdge).toBe("right")
})

test("quarter bands reject exits that cannot retain via-safe edge margins", () => {
  const exactFit = createCapacityFixture(2)
  expect(
    () =>
      new FanoutSolver(exactFit.srj, {
        buses: [exactFit.bus],
        sharedBoundary: { minX: -2, maxX: 2, minY: -1.2, maxY: 1.2 },
      }),
  ).not.toThrow()

  const oneTooMany = createCapacityFixture(3)
  expect(
    () =>
      new FanoutSolver(oneTooMany.srj, {
        buses: [oneTooMany.bus],
        sharedBoundary: { minX: -2, maxX: 2, minY: -1.2, maxY: 1.2 },
      }),
  ).toThrow("cannot fit 3 via-safe exits")
})
