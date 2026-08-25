import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"

test("layered winding buses sharing a corner reserve distinct boundary exits", () => {
  const coordinates = [-1.05, -0.35, 0.35, 1.05]
  const sharedBoundary = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const busInputs = [
    {
      busId: "FIRST",
      column: 2,
      targetY: 1,
      allowedLayers: ["inner1", "inner2"],
    },
    {
      busId: "SECOND",
      column: 1,
      targetY: 2,
      allowedLayers: ["inner3", "bottom"],
    },
  ] as const
  const connections: SimpleRouteJson["connections"] = busInputs.map(
    ({ busId, column, targetY, allowedLayers }) => ({
      name: busId,
      pointsToConnect: [
        {
          x: coordinates[column]!,
          y: coordinates[3]!,
          layer: "top",
          pointId: `soc-pad-${column}-3`,
        },
        { x: 5, y: targetY, layer: allowedLayers[0] },
      ],
    }),
  )
  const obstacles: Obstacle[] = coordinates.flatMap((x, column) =>
    coordinates.map((y, row) => {
      const obstacleId = `soc-pad-${column}-${row}`
      return {
        obstacleId,
        componentId: "soc",
        type: "rect",
        center: { x, y },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [
          obstacleId,
          ...connections
            .filter((connection) =>
              connection.pointsToConnect.some(
                (point) => point.pointId === obstacleId,
              ),
            )
            .map((connection) => connection.name),
        ],
      }
    }),
  )
  const buses: FanoutBusSpec[] = busInputs.map(
    ({ busId, targetY, allowedLayers }) => ({
      busId,
      connectionNames: [busId],
      sourceComponentId: "soc",
      direction: "up",
      preferredExit: "top-right",
      exitEdge: "right",
      allowedLayers,
      connectionExitTargets: {
        [busId]: { x: 8, y: targetY, layer: allowedLayers[0] },
      },
    }),
  )
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 6,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -4, maxX: 4, minY: -4, maxY: 4 },
    obstacles,
    connections,
    buses,
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    buses,
    sharedBoundary,
    escapeLayers: ["inner1", "inner2", "inner3", "bottom"],
    compactBusTracks: true,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  const exits = output.fanoutTraces.map((trace) => trace.route.at(-1)!)
  expect(
    exits.every(
      (exit) => exit.route_type === "wire" && exit.x === sharedBoundary.maxX,
    ),
  ).toBe(true)
  expect(
    new Set(
      exits.flatMap((exit) => (exit.route_type === "wire" ? [exit.y] : [])),
    ).size,
  ).toBe(exits.length)

  const sameLayerBuses: FanoutBusSpec[] = buses.map((bus) => ({
    ...bus,
    allowedLayers: ["inner1"],
    connectionExitTargets: Object.fromEntries(
      bus.connectionNames.map((connectionName) => [
        connectionName,
        {
          ...(bus.connectionExitTargets?.[connectionName] ?? { x: 8, y: 0 }),
          layer: "inner1",
        },
      ]),
    ),
  }))
  const sameLayerSolver = new FanoutSolver(
    { ...simpleRouteJson, buses: sameLayerBuses },
    {
      buses: sameLayerBuses,
      sharedBoundary,
      escapeLayers: ["inner1"],
      compactBusTracks: true,
    },
  )

  sameLayerSolver.solve()

  expect(sameLayerSolver.failed).toBe(false)
  const sameLayerOutput = sameLayerSolver.getOutput()
  expect(sameLayerOutput.validation).toMatchObject({ valid: true, issues: [] })
  for (const trace of sameLayerOutput.fanoutTraces) {
    expect(
      trace.route.filter((routePoint) => routePoint.route_type === "via"),
    ).toHaveLength(1)
  }
})
