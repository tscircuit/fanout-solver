import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("coordinated winding falls back to contained via-in-pad terminals", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const sourcePoints = simpleRouteJson.connections.map(
    (connection) => connection.pointsToConnect[0]!,
  )
  const dogboneViaBlockers: Obstacle[] = sourcePoints.map(
    (sourcePoint, index) => ({
      obstacleId: `dogbone-via-blocker-${index}`,
      componentId: `blocker-${index}`,
      type: "rect",
      center: { x: sourcePoint.x, y: sourcePoint.y + 0.401 },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      connectedTo: [`BLOCKER_${index}`],
    }),
  )
  const solver = new FanoutSolver(
    {
      ...simpleRouteJson,
      obstacles: [...simpleRouteJson.obstacles, ...dogboneViaBlockers],
    },
    {
      buses: [bus],
      sharedBoundary,
      escapeLayers: ["inner1", "inner2"],
      compactBusTracks: true,
    },
  )

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(output.fanoutTraces).toHaveLength(sourcePoints.length)
  for (const [
    connectionIndex,
    connection,
  ] of simpleRouteJson.connections.entries()) {
    const sourcePoint = sourcePoints[connectionIndex]!
    const trace = output.fanoutTraces.find(
      (candidate) => candidate.connection_name === connection.name,
    )!
    const viaIndex = trace.route.findIndex(
      (routePoint) => routePoint.route_type === "via",
    )
    expect(viaIndex).toBe(1)
    expect(trace.route.slice(0, 3)).toMatchObject([
      {
        route_type: "wire",
        x: sourcePoint.x,
        y: sourcePoint.y,
        layer: "top",
      },
      {
        route_type: "via",
        x: sourcePoint.x,
        y: sourcePoint.y,
        from_layer: "top",
      },
      {
        route_type: "wire",
        x: sourcePoint.x,
        y: sourcePoint.y,
      },
    ])
  }
})
