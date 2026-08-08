import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

function createProblem(obstacleLayers: string[]): SimpleRouteJson {
  const connectionName = "SIG"
  const buses: FanoutBusSpec[] = [
    {
      busId: "signal",
      connectionNames: [connectionName],
      sourceComponentId: "U1",
      direction: "right",
    },
  ]
  return {
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, maxX: 2, minY: -1, maxY: 1 },
    obstacles: [
      {
        obstacleId: "source-pad",
        componentId: "U1",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: [connectionName, "source-pad"],
      },
      {
        obstacleId: "inner-layer-pad",
        componentId: "J1",
        type: "rect",
        center: { x: 0.4, y: 0 },
        width: 0.8,
        height: 0.8,
        layers: obstacleLayers,
        connectedTo: [],
      },
    ],
    connections: [
      {
        name: connectionName,
        pointsToConnect: [
          {
            x: 0,
            y: 0,
            layer: "top",
            pointId: "source-pad",
            pcb_port_id: "source-pad",
          },
          { x: 1.5, y: 0, layer: "top" },
        ],
      },
    ],
    buses: buses as NonNullable<SimpleRouteJson["buses"]>,
  }
}

test("a via is rejected by an obstacle on an intermediate span layer", () => {
  const solver = new FanoutSolver(createProblem(["inner2"]), {
    sharedBoundary: { minX: -0.5, maxX: 1, minY: -0.8, maxY: 0.8 },
    escapeLayers: ["bottom"],
  })

  solver.solve()

  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
})

test("an obstacle outside the via span does not block the fanout", () => {
  const solver = new FanoutSolver(createProblem(["inner2"]), {
    sharedBoundary: { minX: -0.5, maxX: 1, minY: -0.8, maxY: 0.8 },
    escapeLayers: ["inner1"],
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.solved).toBe(true)
  expect(
    solver
      .getOutput()
      .fanoutTraces[0]!.route.some(
        (routePoint) => routePoint.route_type === "via",
      ),
  ).toBe(true)
})
