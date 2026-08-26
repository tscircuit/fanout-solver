import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { createLayeredWindingChannelFixture } from "tests/fixtures/layered-winding-channel"

test("a loose bus length-skew constraint leaves fanout geometry unchanged", () => {
  const { bus, sharedBoundary, simpleRouteJson } =
    createLayeredWindingChannelFixture({ includeTargetLayers: true })
  const createSolver = (solverBus: FanoutBusSpec) =>
    new FanoutSolver(
      { ...simpleRouteJson, buses: [solverBus] },
      {
        buses: [solverBus],
        sharedBoundary,
        escapeLayers: ["inner1", "inner2"],
        compactBusTracks: true,
      },
    )

  const baselineSolver = createSolver(bus)
  baselineSolver.solve()
  expect(baselineSolver.failed).toBe(false)

  const looseBus: FanoutBusSpec = { ...bus, maxLengthSkew: 100 }
  const looseSolver = createSolver(looseBus)
  looseSolver.solve()
  expect(looseSolver.failed).toBe(false)

  const baselineOutput = baselineSolver.getOutput()
  const looseOutput = looseSolver.getOutput()
  expect(looseOutput.validation).toEqual(baselineOutput.validation)
  expect(looseOutput.busLayerAssignments).toEqual(
    baselineOutput.busLayerAssignments,
  )
  expect(looseOutput.fanoutTraces).toEqual(baselineOutput.fanoutTraces)
})
