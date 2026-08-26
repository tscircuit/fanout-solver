import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

function createPlaneTerminationProblem(): {
  simpleRouteJson: SimpleRouteJson
  buses: FanoutBusSpec[]
} {
  const connectionName = "VSS_A1"
  const buses: FanoutBusSpec[] = [
    {
      busId: "ground",
      connectionNames: [connectionName],
      direction: "right",
      termination: { type: "plane", layer: "inner1" },
    },
  ]
  return {
    simpleRouteJson: {
      layerCount: 8,
      minTraceWidth: 0.1,
      nominalTraceWidth: 0.1,
      minViaPadDiameter: 0.25,
      minViaHoleDiameter: 0.15,
      minTraceToPadEdgeClearance: 0.1,
      minViaEdgeToPadEdgeClearance: 0.1,
      defaultObstacleMargin: 0.1,
      bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
      connections: [
        {
          name: connectionName,
          pointsToConnect: [
            {
              x: -0.4,
              y: 0.4,
              layer: "top",
              pointId: "bga:A1",
              pcb_port_id: "bga:A1",
            },
          ],
        },
      ],
      obstacles: [
        [-0.4, 0.4],
        [0.4, 0.4],
        [-0.4, -0.4],
        [0.4, -0.4],
      ].map(([x, y], index) => ({
        obstacleId: `pad-${index}`,
        componentId: "bga",
        type: "rect" as const,
        shape: "circle" as const,
        center: { x, y },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: index === 0 ? [connectionName, "bga:A1"] : [],
      })),
      buses: buses as NonNullable<SimpleRouteJson["buses"]>,
    },
    buses,
  }
}

test("a source-only plane target dogbones to a through-all via", () => {
  const { simpleRouteJson, buses } = createPlaneTerminationProblem()
  const solver = new FanoutSolver(simpleRouteJson, {
    buses,
    sharedBoundary: { minX: -1.5, maxX: 1.5, minY: -1.5, maxY: 1.5 },
    escapeLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
  })
  solver.solve()
  expect(solver.failed).toBe(false)

  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(1)
  expect(output.planeTerminations).toHaveLength(1)
  expect(output.simpleRouteJson.connections).toHaveLength(0)
  expect(output.simpleRouteJson.buses).toHaveLength(0)
  expect(output.busLayerAssignments.ground).toBe("inner1")

  const termination = output.planeTerminations[0]!
  expect(termination.connectionName).toBe("VSS_A1")
  expect(termination.layer).toBe("inner1")
  expect(termination.via.center).toEqual({ x: 0, y: 0.4 })
  expect(termination.via.fromLayer).toBe("top")
  expect(termination.via.toLayer).toBe("inner1")
  expect(termination.via.spanLayers).toEqual([
    "top",
    "inner1",
    "inner2",
    "inner3",
    "inner4",
    "inner5",
    "inner6",
    "bottom",
  ])
  expect(termination.via.center.x).not.toBe(-0.4)

  const trace = output.fanoutTraces[0]!
  expect(trace.route.map((point) => point.route_type)).toEqual([
    "wire",
    "wire",
    "via",
    "wire",
  ])
  const vias = trace.route.filter((point) => point.route_type === "via")
  expect(vias).toHaveLength(1)
  const via = vias[0]
  expect(via).toMatchObject({
    route_type: "via",
    x: 0,
    y: 0.4,
    from_layer: "top",
    to_layer: "inner1",
    layers: [
      "top",
      "inner1",
      "inner2",
      "inner3",
      "inner4",
      "inner5",
      "inner6",
      "bottom",
    ],
  })
  expect(trace.route.at(-1)).toMatchObject({
    route_type: "wire",
    x: 0,
    y: 0.4,
    layer: "inner1",
  })
  const viaObstacle = output.simpleRouteJson.obstacles.find(
    (obstacle) =>
      obstacle.center.x === via?.x &&
      obstacle.center.y === via?.y &&
      obstacle.connectedTo?.includes(trace.pcb_trace_id),
  )
  expect(viaObstacle?.layers).toEqual([
    "top",
    "inner1",
    "inner2",
    "inner3",
    "inner4",
    "inner5",
    "inner6",
    "bottom",
  ])
  expect(
    trace.route.every(
      (point) =>
        point.route_type !== "wire" ||
        point.x < 1.5 - 1e-6 ||
        point.y < 1.5 - 1e-6,
    ),
  ).toBe(true)
})

test("plane targets validate their layer and cannot request a border exit", () => {
  const { simpleRouteJson, buses } = createPlaneTerminationProblem()
  expect(
    () =>
      new FanoutSolver(simpleRouteJson, {
        buses: [
          {
            ...buses[0]!,
            termination: { type: "plane", layer: "inner9" },
          },
        ],
      }),
  ).toThrow('targets unavailable layer "inner9"')
  expect(
    () =>
      new FanoutSolver(simpleRouteJson, {
        buses: [{ ...buses[0]!, preferredExit: "right" }],
      }),
  ).toThrow("cannot also specify preferredExit")
  expect(
    () =>
      new FanoutSolver(simpleRouteJson, {
        buses: [
          {
            ...buses[0]!,
            direction: "up",
            exitPosition: "rightside_top",
          },
        ],
      }),
  ).toThrow("cannot also specify preferredExit")
})
