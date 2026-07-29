import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"

function createSimpleRouteJson(): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -2, maxX: 5, minY: -2, maxY: 2 },
    obstacles: [
      {
        obstacleId: "pad",
        componentId: "U1",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["SIG", "pad"],
      },
    ],
    connections: [
      {
        name: "SIG",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pointId: "pad", pcb_port_id: "pad" },
          { x: 4.5, y: 0, layer: "top" },
        ],
      },
    ],
    buses: [{ busId: "signal", connectionNames: ["SIG"] }],
  }
}

test("availableCornersAndSides restricts a fanout to the requested edge", () => {
  const solver = new FanoutSolver(createSimpleRouteJson(), {
    sharedBoundary: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
    availableCornersAndSides: ["top_left", "top_middle", "top_right"],
  })

  expect(solver.preparedBuses[0]).toMatchObject({
    direction: "up",
    preferredExit: "top",
  })

  solver.solve()
  if (solver.failed) {
    throw new Error(solver.error ?? "Expected top-only fanout to solve")
  }
  const exit = solver.getOutput().fanoutTraces[0]!.route.at(-1)!
  expect(exit.route_type).toBe("wire")
  if (exit.route_type === "wire") expect(exit.y).toBeCloseTo(1)
})

test("edge aliases and invalid availability constraints are validated", () => {
  const topAliasSolver = new FanoutSolver(createSimpleRouteJson(), {
    availableCornersAndSides: ["top"],
  })
  expect(topAliasSolver.preparedBuses[0]).toMatchObject({
    direction: "up",
    preferredExit: "top",
  })

  expect(
    () =>
      new FanoutSolver(createSimpleRouteJson(), {
        availableCornersAndSides: [],
      }),
  ).toThrow("must contain at least one boundary region")
  expect(
    () =>
      new FanoutSolver(createSimpleRouteJson(), {
        defaultDirection: "right",
        availableCornersAndSides: ["top"],
      }),
  ).toThrow("cannot use its requested exit")
})
