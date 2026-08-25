import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("layered exit targets reject unavailable copper layers", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const invalidBus = {
    ...bus,
    connectionExitTargets: {
      ...bus.connectionExitTargets,
      DATA0: { x: 8, y: 0.6, layer: "not-a-copper-layer" },
    },
  }

  expect(
    () =>
      new FanoutSolver(
        { ...simpleRouteJson, buses: [invalidBus] },
        {
          buses: [invalidBus],
          sharedBoundary,
          escapeLayers: ["inner1", "inner2"],
        },
      ),
  ).toThrow(
    'connection exit target for "DATA0" uses unavailable layer "not-a-copper-layer"',
  )
})
