import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import {
  RP2350A_PACKAGE_BOUNDS,
  rp2350aBreakoutFanoutInput,
} from "../datasets/dataset07"

const { simpleRouteJson, solverOptions } = rp2350aBreakoutFanoutInput

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
  // The routable area is the breakout region: exactly the footprint extent.
  expect(simpleRouteJson.bounds.minX).toBeCloseTo(RP2350A_PACKAGE_BOUNDS.minX)
  expect(simpleRouteJson.bounds.maxX).toBeCloseTo(RP2350A_PACKAGE_BOUNDS.maxX)
  expect(simpleRouteJson.bounds.minY).toBeCloseTo(RP2350A_PACKAGE_BOUNDS.minY)
  expect(simpleRouteJson.bounds.maxY).toBeCloseTo(RP2350A_PACKAGE_BOUNDS.maxY)
})

test("Dataset 07 fans out the RP2350A QFN60 breakout", () => {
  const solver = new FanoutSolver(simpleRouteJson, solverOptions)
  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.solved).toBe(true)

  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(simpleRouteJson.connections.length)

  // The inferred shared boundary is clamped to the routable area, so every
  // route stays inside srj.bounds and ends exactly on the boundary edge.
  const boundary = solver.preparedBuses[0]!.sharedBoundary
  expect(boundary.minX).toBeCloseTo(simpleRouteJson.bounds.minX, 6)
  expect(boundary.maxX).toBeCloseTo(simpleRouteJson.bounds.maxX, 6)
  expect(boundary.minY).toBeCloseTo(simpleRouteJson.bounds.minY, 6)
  expect(boundary.maxY).toBeCloseTo(simpleRouteJson.bounds.maxY, 6)
  for (const trace of output.fanoutTraces) {
    for (const routePoint of trace.route) {
      expect(
        routePoint.route_type === "wire" || routePoint.route_type === "via",
      ).toBe(true)
      if (routePoint.route_type !== "wire" && routePoint.route_type !== "via") {
        continue
      }
      expect(routePoint.x).toBeGreaterThanOrEqual(
        simpleRouteJson.bounds.minX - 1e-6,
      )
      expect(routePoint.x).toBeLessThanOrEqual(
        simpleRouteJson.bounds.maxX + 1e-6,
      )
      expect(routePoint.y).toBeGreaterThanOrEqual(
        simpleRouteJson.bounds.minY - 1e-6,
      )
      expect(routePoint.y).toBeLessThanOrEqual(
        simpleRouteJson.bounds.maxY + 1e-6,
      )
    }
    const exit = trace.route.at(-1)!
    expect(exit.route_type).toBe("wire")
    if (exit.route_type !== "wire") continue
    const onBoundaryEdge =
      Math.abs(exit.x - boundary.minX) < 1e-6 ||
      Math.abs(exit.x - boundary.maxX) < 1e-6 ||
      Math.abs(exit.y - boundary.minY) < 1e-6 ||
      Math.abs(exit.y - boundary.maxY) < 1e-6
    expect(onBoundaryEdge).toBe(true)
  }
})

test("Dataset 07 escapes placeholder-target pads through their own edge", () => {
  const solver = new FanoutSolver(simpleRouteJson, solverOptions)

  // Fourteen captured breakout targets are a placeholder at the package
  // centre. Direction inference must not send those buses across the package;
  // each escapes through the boundary edge nearest its source pad.
  for (const bus of solver.preparedBuses) {
    const connection = bus.connections[0]!
    const target = connection.targetPoint
    const isPlaceholderTarget =
      Math.abs(target.x) < 1e-9 && Math.abs(target.y) < 1e-9
    if (!isPlaceholderTarget) continue
    const source = connection.sourcePoint
    const nearestEdge = (
      [
        ["left", source.x - bus.sharedBoundary.minX],
        ["right", bus.sharedBoundary.maxX - source.x],
        ["down", source.y - bus.sharedBoundary.minY],
        ["up", bus.sharedBoundary.maxY - source.y],
      ] as const
    ).toSorted((a, b) => a[1] - b[1])[0]![0]
    expect(bus.direction).toBe(nearestEdge)
  }
  expect(
    solver.preparedBuses.filter((bus) => {
      const target = bus.connections[0]!.targetPoint
      return Math.abs(target.x) < 1e-9 && Math.abs(target.y) < 1e-9
    }),
  ).toHaveLength(14)
})

test("Dataset 07 solves with only the package's own pad obstacles", () => {
  const packageObstacles = simpleRouteJson.obstacles.filter(isInsidePackage)
  expect(packageObstacles.length).toBeLessThan(simpleRouteJson.obstacles.length)
  const solver = new FanoutSolver(
    { ...simpleRouteJson, obstacles: packageObstacles },
    solverOptions,
  )
  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.solved).toBe(true)
  expect(solver.getOutput().fanoutTraces).toHaveLength(
    simpleRouteJson.connections.length,
  )
})
