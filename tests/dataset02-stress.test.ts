import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { Bounds, FanoutDirection, Point2D } from "lib/types"
import { fanoutDataset02 } from "../datasets/dataset02"

function pointIsOutsideInDirection(
  point: Point2D,
  bounds: Bounds,
  direction: FanoutDirection,
): boolean {
  switch (direction) {
    case "left":
      return point.x < bounds.minX
    case "right":
      return point.x > bounds.maxX
    case "up":
      return point.y > bounds.maxY
    case "down":
      return point.y < bounds.minY
  }
}

test("Dataset 02 fully routes progressively harder shared-boundary samples", () => {
  const expectedConnectionCounts = [196, 244, 344, 408, 472]
  let blockedCorridorAttemptCount = 0
  expect(fanoutDataset02).toHaveLength(5)

  for (let index = 0; index < fanoutDataset02.length; index++) {
    const sample = fanoutDataset02[index]!
    const padObstacles = sample.simpleRouteJson.obstacles.filter(
      (obstacle) => obstacle.componentId,
    )
    expect(sample.footprintCount).toBe(index + 1)
    expect(sample.simpleRouteJson.layerCount).toBe(6)
    expect(sample.simpleRouteJson.connections).toHaveLength(
      expectedConnectionCounts[index],
    )
    expect(padObstacles).toHaveLength(expectedConnectionCounts[index])
    const componentBounds = Object.values(sample.componentBounds)
    expect(sample.sharedBoundary.minX).toBeCloseTo(
      Math.min(...componentBounds.map((bounds) => bounds.minX)) - 0.8,
    )
    expect(sample.sharedBoundary.maxX).toBeCloseTo(
      Math.max(...componentBounds.map((bounds) => bounds.maxX)) + 0.8,
    )
    expect(sample.sharedBoundary.minY).toBeCloseTo(
      Math.min(...componentBounds.map((bounds) => bounds.minY)) - 0.8,
    )
    expect(sample.sharedBoundary.maxY).toBeCloseTo(
      Math.max(...componentBounds.map((bounds) => bounds.maxY)) + 0.8,
    )

    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    solver.solve()
    expect(solver.failed).toBe(false)

    const output = solver.getOutput()
    if (index === 4) blockedCorridorAttemptCount = output.attempts.length
    expect(output.fanoutTraces).toHaveLength(expectedConnectionCounts[index])
    expect(
      output.fanoutTraces.every((trace) =>
        trace.route.some((routePoint) => routePoint.route_type === "via"),
      ),
    ).toBe(true)

    for (const bus of solver.preparedBuses) {
      const expectedLayer = output.busLayerAssignments[bus.busId]
      for (const connection of bus.connections) {
        const trace = output.fanoutTraces.find(
          (candidate) =>
            candidate.connection_name === connection.connection.name,
        )!
        const via = trace.route.find(
          (routePoint) => routePoint.route_type === "via",
        )
        const exit = trace.route.at(-1)!
        expect(via?.route_type).toBe("via")
        if (via?.route_type === "via") {
          expect(via.to_layer).toBe(expectedLayer)
        }
        expect(exit.route_type).toBe("wire")
        if (exit.route_type === "wire") {
          expect(
            pointIsOutsideInDirection(
              exit,
              sample.sharedBoundary,
              bus.direction,
            ),
          ).toBe(true)
        }
      }
    }
  }

  expect(blockedCorridorAttemptCount).toBeGreaterThan(1)
  expect(
    fanoutDataset02[4]!.simpleRouteJson.obstacles.find(
      (obstacle) =>
        obstacle.obstacleId === "stress-inner1-north-corridor-barrier",
    )?.layers,
  ).toEqual(["inner1"])
}, 30_000)
