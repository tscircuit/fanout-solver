import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { Bounds, FanoutDirection } from "lib/types"
import {
  fanoutDataset05,
  rk3588BallAssignments,
  type Rk3588BallAssignment,
} from "../datasets/dataset05"

function getExpectedCenter(ball: Rk3588BallAssignment): {
  x: number
  y: number
} {
  return {
    x: (ball.position.gridX - 16.5) * 0.8,
    y: (16.5 - ball.position.gridY) * 0.8,
  }
}

function isOnBoundary(
  point: { x: number; y: number },
  boundary: Bounds,
): boolean {
  return (
    Math.abs(point.x - boundary.minX) < 1e-6 ||
    Math.abs(point.x - boundary.maxX) < 1e-6 ||
    Math.abs(point.y - boundary.minY) < 1e-6 ||
    Math.abs(point.y - boundary.maxY) < 1e-6
  )
}

test("Dataset 05 preserves the exact RK3588 map and completes plane-aware fanout", () => {
  const sample = fanoutDataset05[0]!
  const srj = sample.simpleRouteJson
  const buses = sample.solverOptions.buses!
  const assignmentByBall = new Map(
    rk3588BallAssignments.balls.map((ball) => [ball.ball, ball]),
  )

  expect(rk3588BallAssignments.device).toEqual({
    manufacturer: "Rockchip",
    name: "RK3588",
    package: "FCBGA1088L",
  })
  expect(rk3588BallAssignments.grid).toMatchObject({
    rowCount: 34,
    columnCount: 34,
    potentialPositionCount: 1156,
    populatedBallCount: 1088,
    unpopulatedPositionCount: 68,
  })
  expect(rk3588BallAssignments.balls).toHaveLength(1088)
  expect(rk3588BallAssignments.unpopulatedPositions).toHaveLength(68)
  expect(srj.connections).toHaveLength(1088)
  expect(srj.obstacles).toHaveLength(1088)

  const categoryCounts = rk3588BallAssignments.balls.reduce<
    Record<string, number>
  >((counts, ball) => {
    counts[ball.categoryId] = (counts[ball.categoryId] ?? 0) + 1
    return counts
  }, {})
  expect(categoryCounts.ground).toBe(422)
  expect(categoryCounts.power).toBe(167)
  expect(1088 - categoryCounts.ground! - categoryCounts.power!).toBe(499)

  const seenBalls = new Set<string>()
  for (const connection of srj.connections) {
    const exactConnection = connection as typeof connection & {
      rk3588BallAssignment: Rk3588BallAssignment
    }
    const ball = exactConnection.rk3588BallAssignment
    expect(ball).toEqual(assignmentByBall.get(ball.ball)!)
    expect(connection.name).toBe(`RK3588:${ball.ball}:${ball.name}`)
    expect(connection.pointsToConnect[0]).toMatchObject(getExpectedCenter(ball))
    expect(connection.pointsToConnect).toHaveLength(
      ball.categoryId === "ground" || ball.categoryId === "power" ? 1 : 2,
    )
    seenBalls.add(ball.ball)
  }
  expect(seenBalls.size).toBe(1088)
  for (const vacancy of rk3588BallAssignments.unpopulatedPositions) {
    expect(seenBalls.has(vacancy.ball)).toBe(false)
  }

  const planeBuses = buses.filter((bus) => bus.termination?.type === "plane")
  const boundaryBuses = buses.filter(
    (bus) => bus.termination?.type === "boundary",
  )
  expect(planeBuses).toHaveLength(589)
  expect(boundaryBuses.length).toBeGreaterThan(100)
  expect(
    planeBuses.filter(
      (bus) =>
        bus.busId.startsWith("rk3588:ground:") &&
        bus.termination?.type === "plane" &&
        bus.termination.layer === "inner1",
    ),
  ).toHaveLength(422)
  expect(
    planeBuses.filter(
      (bus) =>
        bus.busId.startsWith("rk3588:power:") &&
        bus.termination?.type === "plane" &&
        bus.termination.layer === "inner2",
    ),
  ).toHaveLength(167)

  const solver = new FanoutSolver(srj, sample.solverOptions)
  solver.solve()
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(1088)
  expect(output.planeTerminations).toHaveLength(589)
  expect(output.simpleRouteJson.connections).toHaveLength(499)
  expect(output.attempts).toHaveLength(1)
  expect(output.attempts[0]!.failedBusIds).toEqual([])

  const planeViaKeys = new Set<string>()
  for (const termination of output.planeTerminations) {
    const ballName = termination.connectionName.split(":")[1]!
    const ball = assignmentByBall.get(ballName)!
    const source = getExpectedCenter(ball)
    const dx = Math.abs(termination.via.center.x - source.x)
    const dy = Math.abs(termination.via.center.y - source.y)
    expect(dx + dy).toBeCloseTo(0.4)
    expect(Math.min(dx, dy)).toBeCloseTo(0)
    expect(termination.via.center).not.toEqual(source)
    expect(termination.layer).toBe(
      ball.categoryId === "ground" ? "inner1" : "inner2",
    )
    planeViaKeys.add(
      `${termination.via.center.x.toFixed(4)}:${termination.via.center.y.toFixed(4)}`,
    )
  }
  expect(planeViaKeys.size).toBe(589)

  for (const connection of output.simpleRouteJson.connections) {
    const exit = connection.pointsToConnect.find((point) =>
      point.pointId?.startsWith("fanout-exit:"),
    )
    expect(exit).toBeDefined()
    expect(isOnBoundary(exit!, sample.sharedBoundary)).toBe(true)
  }

  const layerByDirection = solver.preparedBuses
    .filter((bus) => bus.termination.type === "boundary")
    .reduce<Record<FanoutDirection, number>>(
      (counts, bus) => {
        counts[bus.direction] += bus.connections.length
        return counts
      },
      { left: 0, right: 0, up: 0, down: 0 },
    )
  expect(Object.values(layerByDirection).every((count) => count > 0)).toBe(true)
})
