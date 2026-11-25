import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import fixture from "./fixtures/left-edge-boundary-dogleg.json"

/**
 * Two left-column balls of an RK3566 (0.8 mm apart, 0.6 mm inside the shared boundary) escape left to connector pads
 * 0.9-2.1 mm further up. The boundary track of each connection is placed at its downstream pad's y, and the
 * single 45-degree dogleg from the escape point to that track needs as much axial run as the track offset
 * (up to 2.1 mm) while only 0.34 mm remain before the boundary. The dogleg overshoots the left boundary edge and the
 * route turns back to end on it; with through vias the corner normalization then rejects the whole fanout.
 */
const load = (allowBlindAndBuriedVias: boolean): FanoutSolver => {
  const { simpleRouteJson, solverOptions } = structuredClone(
    fixture,
  ) as unknown as {
    simpleRouteJson: SimpleRouteJson
    solverOptions: FanoutSolverOptions
  }
  simpleRouteJson.allowBlindAndBuriedVias = allowBlindAndBuriedVias
  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
    allowBlindAndBuriedVias,
  })
  solver.solve()
  return solver
}

test("repro: a boundary dogleg longer than the room to the boundary leaves the shared boundary", () => {
  const boundary = (
    fixture.solverOptions as { sharedBoundary: { minX: number } }
  ).sharedBoundary

  const blind = load(true)
  expect(blind.solved).toBe(true)
  const leftOfBoundary = blind
    .getOutput()
    .fanoutTraces.flatMap((trace) => trace.route)
    .filter((point) => "x" in point && point.x < boundary.minX - 1e-6)
  // Each of the two routes has one point outside the boundary, e.g. CM4_GPIO2 reaches x = 5.484 < 7.230.
  expect(leftOfBoundary).toHaveLength(2)

  const through = load(false)
  expect(through.failed).toBe(true)
  expect(through.error).toContain("could not normalize every corner")
})
