import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

test("a fanout trace may cross copper connected to the same connection", () => {
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 1,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, maxX: 4, minY: -0.3, maxY: 0.3 },
    obstacles: [
      {
        obstacleId: "source-pad",
        componentId: "source-component",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: ["SIGNAL", "source-pad"],
      },
      {
        obstacleId: "connected-copper",
        componentId: "connected-component",
        type: "rect",
        center: { x: 1, y: 0 },
        width: 0.8,
        height: 0.4,
        layers: ["top"],
        connectedTo: ["SIGNAL"],
      },
    ],
    connections: [
      {
        name: "SIGNAL",
        pointsToConnect: [
          {
            x: 0,
            y: 0,
            layer: "top",
            pointId: "source-pad",
            pcb_port_id: "source-pad",
          },
          { x: 4, y: 0, layer: "top" },
        ],
      },
    ],
    buses: [
      {
        busId: "signal-bus",
        connectionNames: ["SIGNAL"],
        sourceComponentId: "source-component",
        direction: "right",
      },
    ] as FanoutBusSpec[],
  }

  const solver = new FanoutSolver(simpleRouteJson, {
    sharedBoundary: { minX: -0.5, maxX: 3, minY: -0.3, maxY: 0.3 },
    escapeLayers: ["top"],
  })
  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.getOutput().fanoutTraces).toHaveLength(1)
  expect(solver.getOutput().fanoutTraces[0]!.route.at(-1)).toMatchObject({
    route_type: "wire",
    x: 3,
    y: 0,
    layer: "top",
  })
})
