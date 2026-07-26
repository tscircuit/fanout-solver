import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { Bounds, FanoutDirection, Point2D } from "lib/types"
import { fanoutDataset01 } from "../datasets/dataset01"

function expectPointOutsideSharedBoundary(
  point: Point2D,
  bounds: Bounds,
  direction: FanoutDirection,
): void {
  switch (direction) {
    case "left":
      expect(point.x).toBeLessThan(bounds.minX)
      return
    case "right":
      expect(point.x).toBeGreaterThan(bounds.maxX)
      return
    case "up":
      expect(point.y).toBeGreaterThan(bounds.maxY)
      return
    case "down":
      expect(point.y).toBeLessThan(bounds.minY)
  }
}

test("every Dataset 01 pad exits the one shared breakout boundary", () => {
  for (const sample of fanoutDataset01) {
    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    solver.solve()
    const output = solver.getOutput()

    for (const bus of solver.preparedBuses) {
      expect(bus.sharedBoundary).toEqual(sample.sharedBoundary)
      for (const preparedConnection of bus.connections) {
        const connectionName = preparedConnection.connection.name
        const outputConnection = output.simpleRouteJson.connections.find(
          (connection) => connection.name === connectionName,
        )!
        const exitPoint = outputConnection.pointsToConnect.find((point) =>
          point.pointId?.startsWith("fanout-exit:"),
        )!
        const trace = output.fanoutTraces.find(
          (candidate) => candidate.connection_name === connectionName,
        )!
        const finalRoutePoint = trace.route.at(-1)!
        if (finalRoutePoint.route_type !== "wire") {
          throw new Error(
            `Fanout trace "${connectionName}" does not end in a wire point`,
          )
        }

        expectPointOutsideSharedBoundary(
          exitPoint,
          sample.sharedBoundary,
          bus.direction,
        )
        expectPointOutsideSharedBoundary(
          finalRoutePoint,
          sample.sharedBoundary,
          bus.direction,
        )
        expect(finalRoutePoint.x).toBeCloseTo(exitPoint.x)
        expect(finalRoutePoint.y).toBeCloseTo(exitPoint.y)
      }
    }
  }
})
