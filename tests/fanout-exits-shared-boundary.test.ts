import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { Bounds, FanoutDirection, Point2D } from "lib/types"
import { fanoutDataset01 } from "../datasets/dataset01"

function expectPointOnSharedBoundary(
  point: Point2D,
  bounds: Bounds,
  direction: FanoutDirection,
): void {
  switch (direction) {
    case "left":
      expect(point.x).toBeCloseTo(bounds.minX)
      break
    case "right":
      expect(point.x).toBeCloseTo(bounds.maxX)
      break
    case "up":
      expect(point.y).toBeCloseTo(bounds.maxY)
      break
    case "down":
      expect(point.y).toBeCloseTo(bounds.minY)
      break
  }
  if (direction === "left" || direction === "right") {
    expect(point.y).toBeGreaterThanOrEqual(bounds.minY)
    expect(point.y).toBeLessThanOrEqual(bounds.maxY)
  } else {
    expect(point.x).toBeGreaterThanOrEqual(bounds.minX)
    expect(point.x).toBeLessThanOrEqual(bounds.maxX)
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

        expectPointOnSharedBoundary(
          exitPoint,
          sample.sharedBoundary,
          bus.direction,
        )
        expectPointOnSharedBoundary(
          finalRoutePoint,
          sample.sharedBoundary,
          bus.direction,
        )
        for (const routePoint of trace.route) {
          if (
            routePoint.route_type !== "wire" &&
            routePoint.route_type !== "via"
          ) {
            throw new Error(
              `Fanout trace "${connectionName}" contains unsupported route type "${routePoint.route_type}"`,
            )
          }
          expect(routePoint.x).toBeGreaterThanOrEqual(
            sample.sharedBoundary.minX - 1e-6,
          )
          expect(routePoint.x).toBeLessThanOrEqual(
            sample.sharedBoundary.maxX + 1e-6,
          )
          expect(routePoint.y).toBeGreaterThanOrEqual(
            sample.sharedBoundary.minY - 1e-6,
          )
          expect(routePoint.y).toBeLessThanOrEqual(
            sample.sharedBoundary.maxY + 1e-6,
          )
        }
        expect(finalRoutePoint.x).toBeCloseTo(exitPoint.x)
        expect(finalRoutePoint.y).toBeCloseTo(exitPoint.y)
      }
    }
  }
}, 30_000)
