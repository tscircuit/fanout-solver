import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"

test("the inferred fanout boundary excludes destination footprints", () => {
  const sourcePads = Array.from({ length: 16 }, (_, padIndex) => ({
    obstacleId: `source-pad-${padIndex}`,
    componentId: "U1",
    type: "rect" as const,
    layers: ["top"],
    center: {
      x: (padIndex % 4) * 0.5 - 0.75,
      y: Math.floor(padIndex / 4) * 0.5 - 0.75,
    },
    width: 0.3,
    height: 0.3,
    connectedTo: [`source-pad-${padIndex}`],
  }))
  const destinationPads = [0, 1].map((padIndex) => ({
    obstacleId: `destination-pad-${padIndex}`,
    componentId: "J1",
    type: "rect" as const,
    layers: ["top"],
    center: { x: 20, y: padIndex - 0.5 },
    width: 0.8,
    height: 0.8,
    connectedTo: [`destination-pad-${padIndex}`],
  }))
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -2, maxX: 21, minY: -2, maxY: 2 },
    obstacles: [...sourcePads, ...destinationPads],
    connections: [0, 1].map((connectionIndex) => ({
      name: `connection-${connectionIndex}`,
      pointsToConnect: [
        {
          x: sourcePads[connectionIndex]!.center.x,
          y: sourcePads[connectionIndex]!.center.y,
          layer: "top",
        },
        {
          x: destinationPads[connectionIndex]!.center.x,
          y: destinationPads[connectionIndex]!.center.y,
          layer: "top",
        },
      ],
    })),
    buses: [
      {
        busId: "data",
        connectionNames: ["connection-0", "connection-1"],
      },
    ],
  }

  const solver = new FanoutSolver(simpleRouteJson)

  expect(solver.preparedBuses[0]!.componentId).toBe("U1")
  expect(solver.preparedBuses[0]!.sharedBoundary.maxX).toBeLessThan(5)
})
