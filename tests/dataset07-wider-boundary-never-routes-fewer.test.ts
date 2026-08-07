import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
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
const solverCache = new Map<number, FanoutSolver>()
const solveWithBoundaryGrownBy = (by: number): FanoutSolver => {
  const cached = solverCache.get(by)
  if (cached) return cached

  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
    sharedBoundary: growBounds(RP2350A_BREAKOUT_BOUNDARY, by),
  })
  solver.solve()
  solverCache.set(by, solver)
  return solver
}

const routedConnectionCountWithBoundaryGrownBy = (by: number): number => {
  const solver = solveWithBoundaryGrownBy(by)
  if (!solver.failed) return connectionCount
  const match = solver.error?.match(/routed (\d+)\/(\d+) connections/)
  if (!match) throw new Error(`unexpected solver error: ${solver.error}`)
  return Number(match[1])
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

// Visual guard: the bug rejected every plan before its geometry mattered, so
// the widened-boundary snapshots showed bare pads with no escapes at all.
test("Dataset 07 fanout at the boundary core resolves", async () => {
  await expect(
    getSvgFromGraphicsObject(solveWithBoundaryGrownBy(0).visualize()),
  ).toMatchSvgSnapshot(import.meta.path, "dataset07-boundary-grown-0mm")
}, 300_000)

test("Dataset 07 fanout with the boundary widened past srj.bounds", async () => {
  await expect(
    getSvgFromGraphicsObject(solveWithBoundaryGrownBy(1.2).visualize()),
  ).toMatchSvgSnapshot(import.meta.path, "dataset07-boundary-grown-1.2mm")
}, 300_000)
