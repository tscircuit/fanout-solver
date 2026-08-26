import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

test("same-net merging supports adjacent via-in-pad plane terminations", () => {
  const sources = [
    { name: "GND_A", x: -0.1 },
    { name: "GND_B", x: 0.1 },
  ]
  const buses: FanoutBusSpec[] = sources.map(({ name }) => ({
    busId: `plane-${name}`,
    connectionNames: [name],
    sourceComponentId: "U1",
    direction: "right",
    termination: { type: "plane", layer: "inner1" },
  }))
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.12,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
    connections: sources.map(({ name, x }) => ({
      name,
      netConnectionName: "GND",
      pointsToConnect: [{ x, y: 0, layer: "top", pointId: `${name}-source` }],
    })),
    obstacles: sources.map(({ name, x }) => ({
      obstacleId: `${name}-pad`,
      componentId: "U1",
      type: "rect" as const,
      center: { x, y: 0 },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      connectedTo: [name, `${name}-source`],
    })),
    buses: buses as NonNullable<SimpleRouteJson["buses"]>,
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    buses,
    sharedBoundary: simpleRouteJson.bounds,
    escapeLayers: ["top", "bottom"],
    allowSameNetMerges: true,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(output.planeTerminations).toHaveLength(2)
  expect(
    output.planeTerminations
      .map(({ via }) => via.center)
      .toSorted((first, second) => first.x - second.x),
  ).toEqual(sources.map(({ x }) => ({ x, y: 0 })))
})
