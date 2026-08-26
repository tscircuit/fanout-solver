import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("coordinated winding prefers contained via-in-pad terminals after plane drops", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const planeConnectionName = "GND_DROP"
  const planeBus: FanoutBusSpec = {
    busId: "ground-plane",
    connectionNames: [planeConnectionName],
    sourceComponentId: "power-pad",
    direction: "right",
    termination: { type: "plane", layer: "inner1" },
  }
  const solver = new FanoutSolver(
    {
      ...simpleRouteJson,
      connections: [
        ...simpleRouteJson.connections,
        {
          name: planeConnectionName,
          pointsToConnect: [
            {
              x: -2,
              y: -2,
              layer: "top",
              pointId: "ground-source",
            },
          ],
        },
      ],
      obstacles: [
        ...simpleRouteJson.obstacles,
        {
          obstacleId: "ground-pad",
          componentId: "power-pad",
          type: "rect",
          center: { x: -2, y: -2 },
          width: 0.3,
          height: 0.3,
          layers: ["top"],
          connectedTo: [planeConnectionName, "ground-source"],
        },
      ],
      buses: [planeBus, bus],
    },
    {
      buses: [planeBus, bus],
      sharedBoundary,
      escapeLayers: ["inner1", "inner2"],
      compactBusTracks: true,
    },
  )

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  for (const connection of simpleRouteJson.connections) {
    const source = connection.pointsToConnect[0]!
    const trace = output.fanoutTraces.find(
      (candidate) => candidate.connection_name === connection.name,
    )!
    expect(trace.route.slice(0, 3)).toMatchObject([
      { route_type: "wire", x: source.x, y: source.y, layer: "top" },
      {
        route_type: "via",
        x: source.x,
        y: source.y,
        from_layer: "top",
      },
      { route_type: "wire", x: source.x, y: source.y },
    ])
  }
})
