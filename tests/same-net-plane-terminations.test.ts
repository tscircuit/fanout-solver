import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

test("same-net plane terminations use offset through-all vias", () => {
  const clearance = 0.08128
  const sources = [
    { name: "GND_A", x: 0 },
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
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    defaultObstacleMargin: clearance,
    bounds: { minX: -1, maxX: 1.5, minY: -1, maxY: 1 },
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
      width: 0.05,
      height: 0.05,
      layers: ["top"],
      connectedTo: [name, `${name}-source`],
    })),
    buses: buses as NonNullable<SimpleRouteJson["buses"]>,
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    buses,
    sharedBoundary: simpleRouteJson.bounds,
    escapeLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: true,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(output.planeTerminations).toHaveLength(2)
  for (const termination of output.planeTerminations) {
    const source = sources.find(
      ({ name }) => name === termination.connectionName,
    )!
    expect(termination.via.center).not.toEqual({ x: source.x, y: 0 })
    expect(termination.via).toMatchObject({
      fromLayer: "top",
      toLayer: "inner1",
      spanLayers: ["top", "inner1", "inner2", "bottom"],
    })
  }
  const [firstVia, secondVia] = output.planeTerminations.map(
    (termination) => termination.via,
  )
  expect(
    Math.hypot(
      firstVia!.center.x - secondVia!.center.x,
      firstVia!.center.y - secondVia!.center.y,
    ),
  ).toBeGreaterThanOrEqual(
    (firstVia!.diameter + secondVia!.diameter) / 2 + clearance,
  )
})
