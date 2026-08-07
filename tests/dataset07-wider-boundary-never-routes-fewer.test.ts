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
 *
 * Memoized because each solve takes a few seconds and the assertions below
 * share sizes.
 */
const routedCache = new Map<number, number>()
const routedConnectionCountWithBoundaryGrownBy = (by: number): number => {
  const cached = routedCache.get(by)
  if (cached !== undefined) return cached

  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
    sharedBoundary: growBounds(RP2350A_BREAKOUT_BOUNDARY, by),
  })
  solver.solve()
  let routed: number
  if (!solver.failed) {
    routed = connectionCount
  } else {
    const match = solver.error?.match(/routed (\d+)\/(\d+) connections/)
    if (!match) throw new Error(`unexpected solver error: ${solver.error}`)
    routed = Number(match[1])
  }
  routedCache.set(by, routed)
  return routed
}

const GROWN_SIZES = [0.3, 0.6, 1.2, 3] as const

test("Dataset 07 preserves the captured RP2350A breakout input", () => {
  expect(connectionCount).toBe(23)
  expect(simpleRouteJson.layerCount).toBe(4)
  for (const connection of simpleRouteJson.connections) {
    expect(connection.pointsToConnect).toHaveLength(2)
  }
})

// Regression guard. Exit points are placed on the shared boundary, but
// containment used to be checked against srj.bounds alone, so a boundary
// outside srj.bounds -- exactly what fanoutBoundaryPadding produces -- had
// every plan rejected before its geometry was considered, taking this input
// from 13/23 to 0/23.
test("widening the shared boundary never routes fewer connections", () => {
  const baseline = routedConnectionCountWithBoundaryGrownBy(0)
  expect(baseline).toBeGreaterThan(0)

  for (const grownBy of GROWN_SIZES) {
    expect(
      routedConnectionCountWithBoundaryGrownBy(grownBy),
    ).toBeGreaterThanOrEqual(baseline)
  }
}, 300_000)

test("Dataset 07 routes strictly more once the boundary clears srj.bounds", () => {
  expect(routedConnectionCountWithBoundaryGrownBy(0.6)).toBeGreaterThan(
    routedConnectionCountWithBoundaryGrownBy(0),
  )
}, 300_000)
