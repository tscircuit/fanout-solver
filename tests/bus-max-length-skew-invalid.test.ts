import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("rejects invalid bus maxLengthSkew values", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })

  for (const maxLengthSkew of [-1, Number.NaN, Infinity, -Infinity]) {
    const invalidBus: FanoutBusSpec = { ...bus, maxLengthSkew }
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
      'FanoutSolver: bus "DATA_BUS" maxLengthSkew must be a finite non-negative number',
    )
  }
})
