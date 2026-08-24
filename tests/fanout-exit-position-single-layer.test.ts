import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createSingleSignalFanoutFixture } from "./fixtures/create-single-signal-fanout"

test("edge-center exit positions retain their edge in single-layer routing", () => {
  const { simpleRouteJson, bus } = createSingleSignalFanoutFixture({
    exitPosition: "rightside_center",
  })
  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    escapeLayers: ["top"],
    singleLayerPushAndShove: true,
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation.valid).toBe(true)
  expect(output.fanoutTraces).toHaveLength(1)
  expect(output.fanoutTraces[0]?.route.at(-1)).toMatchObject({
    route_type: "wire",
    x: 3,
  })
})
