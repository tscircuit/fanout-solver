import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  growBounds,
  RP2350A_BREAKOUT_BOUNDARY,
  rp2350aBreakoutFanoutInput,
} from "../datasets/dataset07"

const { simpleRouteJson, solverOptions } = rp2350aBreakoutFanoutInput
const connectionCount = simpleRouteJson.connections.length

/**
 * Routed count for the same problem with the shared boundary grown by `by` mm.
 * Nothing else changes: same connections, same obstacles, same options.
 */
const routedConnectionCountWithBoundaryGrownBy = (by: number): number => {
  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
    sharedBoundary: growBounds(RP2350A_BREAKOUT_BOUNDARY, by),
  })
  solver.solve()
  if (!solver.failed) return connectionCount
  const match = solver.error?.match(/routed (\d+)\/(\d+) connections/)
  if (!match) throw new Error(`unexpected solver error: ${solver.error}`)
  return Number(match[1])
}

test("Dataset 07 preserves the captured RP2350A breakout input", () => {
  expect(connectionCount).toBe(23)
  expect(simpleRouteJson.layerCount).toBe(4)
  for (const connection of simpleRouteJson.connections) {
    expect(connection.pointsToConnect).toHaveLength(2)
  }
})

test("Dataset 07 currently routes 13/23 at the boundary core resolves", () => {
  expect(routedConnectionCountWithBoundaryGrownBy(0)).toBe(13)
}, 60_000)

test("Dataset 07 currently drops to zero as soon as the boundary is widened", () => {
  // Documents the current behaviour that the invariant test below rejects.
  for (const grownBy of [0.3, 0.6, 1.2, 2, 3]) {
    expect(routedConnectionCountWithBoundaryGrownBy(grownBy)).toBe(0)
  }
}, 120_000)

test.failing("widening the shared boundary should never route fewer connections", () => {
  const baseline = routedConnectionCountWithBoundaryGrownBy(0)

  // Every one of these is the same problem with strictly more room to escape
  // into, so none of them should do worse than the tightest boundary.
  for (const grownBy of [0.3, 0.6, 1.2, 2, 3]) {
    expect(
      routedConnectionCountWithBoundaryGrownBy(grownBy),
    ).toBeGreaterThanOrEqual(baseline)
  }
}, 120_000)
