import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  fanoutDataset07,
  RP2350A_PACKAGE_BOUNDS,
  rp2350aBreakoutFanoutInput,
} from "../datasets/dataset07"

const sample = fanoutDataset07[0]!
const { simpleRouteJson, solverOptions } = rp2350aBreakoutFanoutInput

const solve = (srj = simpleRouteJson, options = solverOptions) => {
  const solver = new FanoutSolver(srj, options)
  solver.solve()
  return solver
}

/** Routed count as reported on the public error string, e.g. "routed 0/27". */
const routedConnectionCount = (solver: FanoutSolver): number | null => {
  if (!solver.failed) return null
  const match = solver.error?.match(/routed (\d+)\/(\d+) connections/)
  return match ? Number(match[1]) : null
}

const isInsidePackage = (obstacle: { center: { x: number; y: number } }) =>
  obstacle.center.x > RP2350A_PACKAGE_BOUNDS.minX - 0.5 &&
  obstacle.center.x < RP2350A_PACKAGE_BOUNDS.maxX + 0.5 &&
  obstacle.center.y > RP2350A_PACKAGE_BOUNDS.minY - 0.5 &&
  obstacle.center.y < RP2350A_PACKAGE_BOUNDS.maxY + 0.5

test("Dataset 07 preserves the captured RP2350A breakout input", () => {
  expect(simpleRouteJson.connections).toHaveLength(27)
  expect(simpleRouteJson.obstacles).toHaveLength(195)
  expect(simpleRouteJson.layerCount).toBe(4)
  // Every connection is a pad plus the point it has to reach outside.
  for (const connection of simpleRouteJson.connections) {
    expect(connection.pointsToConnect).toHaveLength(2)
  }
  // Core supplies no shared boundary or component bounds for this breakout.
  expect(solverOptions.sharedBoundary).toBeUndefined()
  expect(Object.keys(solverOptions.componentBounds ?? {})).toHaveLength(0)
})

test("Dataset 07 currently routes none of the 27 escapes", () => {
  const solver = solve()

  expect(solver.failed).toBe(true)
  expect(solver.error).toContain("routed 0/27")
  expect(routedConnectionCount(solver)).toBe(0)
  expect(solver.preparedBuses.length).toBeGreaterThan(0)
})

test("Dataset 07 is not fixed by supplying bounds or by dropping neighbours", () => {
  // A shared boundary and component bounds, at three different margins.
  for (const margin of [0.6, 1, 2]) {
    const solver = solve(simpleRouteJson, {
      ...solverOptions,
      componentBounds: { U_MCU: RP2350A_PACKAGE_BOUNDS },
      sharedBoundary: {
        minX: RP2350A_PACKAGE_BOUNDS.minX - margin,
        maxX: RP2350A_PACKAGE_BOUNDS.maxX + margin,
        minY: RP2350A_PACKAGE_BOUNDS.minY - margin,
        maxY: RP2350A_PACKAGE_BOUNDS.maxY + margin,
      },
    })
    expect(routedConnectionCount(solver)).toBe(0)
  }

  // Only the package's own pads, with bounds supplied.
  const packageObstacles = simpleRouteJson.obstacles.filter(isInsidePackage)
  expect(packageObstacles.length).toBeLessThan(simpleRouteJson.obstacles.length)
  const solver = solve(
    { ...simpleRouteJson, obstacles: packageObstacles },
    {
      ...solverOptions,
      componentBounds: { U_MCU: RP2350A_PACKAGE_BOUNDS },
      sharedBoundary: sample.sharedBoundary,
    },
  )
  expect(routedConnectionCount(solver)).toBe(0)
})

test.failing("Dataset 07 should fan out the RP2350A QFN60 breakout", () => {
  const solver = solve()

  expect(solver.failed).toBe(false)
  expect(solver.getOutput().fanoutTraces).toHaveLength(
    simpleRouteJson.connections.length,
  )
})
