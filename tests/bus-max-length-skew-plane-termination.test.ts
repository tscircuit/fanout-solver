import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("rejects length matching for a plane-terminated bus", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const {
    connectionExitTargets: _connectionExitTargets,
    exitEdge: _exitEdge,
    preferredExit: _preferredExit,
    ...busWithoutBoundaryTarget
  } = bus
  const planeBus: FanoutBusSpec = {
    ...busWithoutBoundaryTarget,
    maxLengthSkew: 0.25,
    termination: { type: "plane", layer: "inner1" },
  }

  expect(
    () =>
      new FanoutSolver(
        { ...simpleRouteJson, buses: [planeBus] },
        {
          buses: [planeBus],
          sharedBoundary,
          escapeLayers: ["inner1", "inner2"],
        },
      ),
  ).toThrow(
    'FanoutSolver: plane-terminated bus "DATA_BUS" cannot specify maxLengthSkew',
  )
})
