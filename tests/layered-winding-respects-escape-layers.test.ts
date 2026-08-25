import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("layered winding never uses a crossover layer excluded from escapeLayers", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary,
    escapeLayers: ["inner1", "bottom"],
    compactBusTracks: true,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(output.busLayerAssignments.DATA_BUS).toBe("inner1")

  for (const trace of output.fanoutTraces) {
    expect(
      trace.route.every((routePoint) => {
        if (routePoint.route_type === "wire") {
          return routePoint.layer !== "inner2"
        }
        if (routePoint.route_type === "via") {
          return (
            routePoint.from_layer !== "inner2" &&
            routePoint.to_layer !== "inner2"
          )
        }
        return true
      }),
    ).toBe(true)
  }

  const emittedViaObstacles = output.simpleRouteJson.obstacles.filter(
    (obstacle) => obstacle.componentId === undefined,
  )
  expect(emittedViaObstacles).toHaveLength(bus.connectionNames.length)
  expect(
    emittedViaObstacles.every(
      (obstacle) => !obstacle.layers.includes("inner2"),
    ),
  ).toBe(true)
})
