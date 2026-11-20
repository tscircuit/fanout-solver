import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createSingleSignalFanoutFixture } from "./fixtures/create-single-signal-fanout"

test("a clear source prefix remains preferred to an obstructed immediate turn", () => {
  const { simpleRouteJson, bus } = createSingleSignalFanoutFixture({
    direction: "right",
  })
  const input = {
    ...simpleRouteJson,
    obstacles: [
      ...simpleRouteJson.obstacles,
      {
        type: "rect" as const,
        shape: "circle" as const,
        center: { x: 0.75, y: 0.75 },
        width: 0.04,
        height: 0.04,
        layers: ["top"],
        connectedTo: ["foreign"],
      },
    ],
    connections: [
      {
        ...simpleRouteJson.connections[0]!,
        pointsToConnect: [
          simpleRouteJson.connections[0]!.pointsToConnect[0]!,
          { x: 4, y: 1.35, layer: "top" },
        ],
      },
    ],
  }
  const solver = new FanoutSolver(input, {
    buses: [bus],
    escapeLayers: ["top"],
    sharedBoundary: input.bounds,
    clearance: 0.1,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(
    output.fanoutTraces[0]!.route.filter(
      (point) => point.route_type === "wire",
    ).map((point) => [point.x, point.y]),
  ).toEqual([
    [0.35, 0.35],
    [0.651, 0.35],
    [1.651, 1.35],
    [3, 1.35],
  ])
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: output.simpleRouteJson,
      clearance: 0.1,
    }),
  ).toMatchObject({ valid: true, checkedViaCount: 0, issues: [] })
})
