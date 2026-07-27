import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

test("buses can target an edge or corner while exits distribute along the border", () => {
  const buses: FanoutBusSpec[] = [
    {
      busId: "edge-bus",
      connectionNames: ["EDGE_A", "EDGE_B", "EDGE_C"],
      preferredExit: "top",
    },
    {
      busId: "corner-bus",
      connectionNames: ["CORNER"],
    },
  ]
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 1,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -4, maxX: 5, minY: -4, maxY: 4 },
    obstacles: [
      {
        obstacleId: "edge-pad-a",
        componentId: "edge-component",
        type: "rect",
        center: { x: -1, y: 0 },
        width: 0.05,
        height: 0.05,
        layers: ["top"],
        connectedTo: ["EDGE_A", "edge-pad-a"],
      },
      {
        obstacleId: "edge-pad-b",
        componentId: "edge-component",
        type: "rect",
        center: { x: -0.8, y: 0 },
        width: 0.05,
        height: 0.05,
        layers: ["top"],
        connectedTo: ["EDGE_B", "edge-pad-b"],
      },
      {
        obstacleId: "edge-pad-c",
        componentId: "edge-component",
        type: "rect",
        center: { x: 0.8, y: 0 },
        width: 0.05,
        height: 0.05,
        layers: ["top"],
        connectedTo: ["EDGE_C", "edge-pad-c"],
      },
      {
        obstacleId: "corner-pad",
        componentId: "corner-component",
        type: "rect",
        center: { x: 1.5, y: 0 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["CORNER", "corner-pad"],
      },
    ],
    connections: [
      {
        name: "EDGE_A",
        pointsToConnect: [
          {
            x: -1,
            y: 0,
            layer: "top",
            pointId: "edge-pad-a",
            pcb_port_id: "edge-pad-a",
          },
          { x: 4.5, y: 0, layer: "top" },
        ],
      },
      {
        name: "EDGE_B",
        pointsToConnect: [
          {
            x: -0.8,
            y: 0,
            layer: "top",
            pointId: "edge-pad-b",
            pcb_port_id: "edge-pad-b",
          },
          { x: 4.5, y: 0, layer: "top" },
        ],
      },
      {
        name: "EDGE_C",
        pointsToConnect: [
          {
            x: 0.8,
            y: 0,
            layer: "top",
            pointId: "edge-pad-c",
            pcb_port_id: "edge-pad-c",
          },
          { x: 4.5, y: 0, layer: "top" },
        ],
      },
      {
        name: "CORNER",
        pointsToConnect: [
          {
            x: 1.5,
            y: 0,
            layer: "top",
            pointId: "corner-pad",
            pcb_port_id: "corner-pad",
          },
          { x: 4.5, y: 0, layer: "top" },
        ],
      },
    ],
    buses,
  }

  const solver = new FanoutSolver(simpleRouteJson, {
    sharedBoundary: { minX: -3, maxX: 4, minY: -3, maxY: 3 },
    escapeLayers: ["top"],
    singleLayerPushAndShove: true,
    borderDistribution: "even",
    busExitPreferences: {
      "corner-bus": "top-right",
    },
  })
  expect(
    Object.fromEntries(
      solver.preparedBuses.map((bus) => [bus.busId, bus.direction]),
    ),
  ).toEqual({
    "edge-bus": "up",
    "corner-bus": "right",
  })

  solver.solve()
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  const edgeAExit = output.fanoutTraces
    .find((trace) => trace.connection_name === "EDGE_A")!
    .route.at(-1)!
  const edgeBExit = output.fanoutTraces
    .find((trace) => trace.connection_name === "EDGE_B")!
    .route.at(-1)!
  const cornerExit = output.fanoutTraces
    .find((trace) => trace.connection_name === "CORNER")!
    .route.at(-1)!
  if (
    edgeAExit.route_type !== "wire" ||
    edgeBExit.route_type !== "wire" ||
    cornerExit.route_type !== "wire"
  ) {
    throw new Error("Expected edge and corner fanouts to end in wire points")
  }
  expect(edgeAExit.y).toBeGreaterThan(3)
  expect(edgeBExit.y).toBeGreaterThan(3)
  expect(Math.abs(edgeAExit.x - edgeBExit.x)).toBeGreaterThan(0.8)
  expect(cornerExit.x).toBeGreaterThan(4)
  expect(cornerExit.y).toBeGreaterThanOrEqual(2.85)
  expect(
    output.fanoutTraces.every((trace) =>
      trace.route.every(
        (point) => point.route_type === "wire" && point.layer === "top",
      ),
    ),
  ).toBe(true)
})
