import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("unlayered paired exits retain the legacy single-transition fanout", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: false })
  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary,
    escapeLayers: ["inner1", "inner2"],
    compactBusTracks: true,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(
    output.fanoutTraces.every(
      (trace) =>
        trace.route.filter((routePoint) => routePoint.route_type === "via")
          .length === 1,
    ),
  ).toBe(true)
})
