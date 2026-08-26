import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

test("an explicit SRJ allowViaInPad opts a plane drop into via-in-pad", () => {
  const connectionName = "GND_A1"
  const bus: FanoutBusSpec = {
    busId: "ground",
    connectionNames: [connectionName],
    sourceComponentId: "U1",
    direction: "right",
    termination: { type: "plane", layer: "inner1" },
  }
  const simpleRouteJson: SimpleRouteJson & { allowViaInPad?: boolean } = {
    allowViaInPad: true,
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.12,
    minTraceToPadEdgeClearance: 0.08,
    minViaEdgeToPadEdgeClearance: 0.08,
    defaultObstacleMargin: 0.08,
    bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
    connections: [
      {
        name: connectionName,
        pointsToConnect: [{ x: 0, y: 0, layer: "top", pointId: "U1.A1" }],
      },
    ],
    obstacles: [
      {
        obstacleId: "U1.A1",
        componentId: "U1",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [connectionName, "U1.A1"],
      },
    ],
    buses: [bus],
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary: simpleRouteJson.bounds,
    escapeLayers: ["inner1"],
    allowBlindAndBuriedVias: false,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  const termination = output.planeTerminations[0]!
  expect(termination.via).toMatchObject({
    center: { x: 0, y: 0 },
    fromLayer: "top",
    toLayer: "inner1",
    spanLayers: ["top", "inner1", "inner2", "bottom"],
  })
  expect(output.fanoutTraces[0]!.route).toMatchObject([
    { route_type: "wire", x: 0, y: 0, layer: "top" },
    {
      route_type: "via",
      x: 0,
      y: 0,
      from_layer: "top",
      to_layer: "inner1",
      layers: ["top", "inner1", "inner2", "bottom"],
    },
    { route_type: "wire", x: 0, y: 0, layer: "inner1" },
  ])
})
