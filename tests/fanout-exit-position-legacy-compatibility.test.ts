import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { createSingleSignalFanoutFixture } from "./fixtures/create-single-signal-fanout"

function solveWithBus(busOverrides: Partial<FanoutBusSpec>): FanoutSolver {
  const { simpleRouteJson, bus } = createSingleSignalFanoutFixture(busOverrides)
  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    sharedBoundary: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    escapeLayers: ["bottom"],
    traceWidth: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    clearance: 0.1,
    compactBusTracks: true,
  })
  solver.solve()
  if (solver.failed) {
    throw new Error(solver.error ?? "Expected fanout to solve")
  }
  return solver
}

test("canonical positions preserve explicit-tuple geometry and legacy behavior", () => {
  const canonicalSolver = solveWithBus({
    exitPosition: "rightside_top",
  })
  const explicitTupleSolver = solveWithBus({
    direction: "up",
    preferredExit: "top-right",
    exitEdge: "right",
  })

  expect(canonicalSolver.getOutput().fanoutTraces).toEqual(
    explicitTupleSolver.getOutput().fanoutTraces,
  )

  const { simpleRouteJson, bus } = createSingleSignalFanoutFixture({
    direction: "up",
    preferredExit: "top-right",
  })
  const legacySolver = new FanoutSolver(simpleRouteJson, { buses: [bus] })
  expect(legacySolver.preparedBuses[0]).toMatchObject({
    direction: "up",
    preferredExit: "top-right",
  })
  expect(legacySolver.preparedBuses[0]?.exitEdge).toBeUndefined()
})
