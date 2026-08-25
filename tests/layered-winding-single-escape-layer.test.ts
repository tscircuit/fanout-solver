import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  createLayeredWindingChannelFixture,
  windingTargetOrder,
} from "tests/fixtures/layered-winding-channel"

test("layered winding preserves order with one available escape layer", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary,
    escapeLayers: ["inner1"],
    compactBusTracks: true,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(output.busLayerAssignments.DATA_BUS).toBe("inner1")
  expect(
    output.fanoutTraces
      .map((trace) => ({
        connectionName: trace.connection_name,
        exit: trace.route.at(-1),
      }))
      .toSorted((first, second) => {
        if (first.exit?.route_type !== "wire") return 1
        if (second.exit?.route_type !== "wire") return -1
        return first.exit.y - second.exit.y
      })
      .map(({ connectionName }) => connectionName),
  ).toEqual(windingTargetOrder)
  for (const trace of output.fanoutTraces) {
    expect(
      trace.route.filter((routePoint) => routePoint.route_type === "via"),
    ).toHaveLength(1)
  }
})
