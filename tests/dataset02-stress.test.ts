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

test("Dataset 02 fully routes difficult two-layer shared-boundary samples", () => {
  const expectedConnectionCounts = [100, 200, 228, 256, 356]
  const expectedBusCounts = [10, 20, 26, 32, 42]
  expect(fanoutDataset02).toHaveLength(5)

  for (let index = 0; index < fanoutDataset02.length; index++) {
    const sample = fanoutDataset02[index]!
    const padObstacles = sample.simpleRouteJson.obstacles.filter(
      (obstacle) => obstacle.componentId,
    )
    expect(sample.footprintCount).toBe(index + 1)
    expect(sample.simpleRouteJson.layerCount).toBe(2)
    expect(sample.simpleRouteJson.connections).toHaveLength(
      expectedConnectionCounts[index],
    )
    expect(sample.simpleRouteJson.buses).toHaveLength(expectedBusCounts[index])
    expect(padObstacles).toHaveLength(expectedConnectionCounts[index])
    const componentBounds = Object.values(sample.componentBounds)
    expect(sample.sharedBoundary.minX).toBeCloseTo(
      Math.min(...componentBounds.map((bounds) => bounds.minX)) - 8,
    )
    expect(sample.sharedBoundary.maxX).toBeCloseTo(
      Math.max(...componentBounds.map((bounds) => bounds.maxX)) + 8,
    )
    expect(sample.sharedBoundary.minY).toBeCloseTo(
      Math.min(...componentBounds.map((bounds) => bounds.minY)) - 8,
    )
    expect(sample.sharedBoundary.maxY).toBeCloseTo(
      Math.max(...componentBounds.map((bounds) => bounds.maxY)) + 8,
    )

    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    solver.solve()
    expect(solver.failed).toBe(false)

    const output = solver.getOutput()
    expect(output.fanoutTraces).toHaveLength(expectedConnectionCounts[index])
    expect(new Set(Object.values(output.busLayerAssignments))).toEqual(
      new Set(["bottom"]),
    )

    let spreadExitCount = 0
    for (const bus of solver.preparedBuses) {
      const expectedLayer = output.busLayerAssignments[bus.busId]
      const perpendicularCoordinates =
        bus.direction === "left" || bus.direction === "right"
          ? bus.yCoordinates
          : bus.xCoordinates
      const componentTrackMinimum = Math.min(...perpendicularCoordinates)
      const componentTrackMaximum = Math.max(...perpendicularCoordinates)

      for (const connection of bus.connections) {
        const trace = output.fanoutTraces.find(
          (candidate) =>
            candidate.connection_name === connection.connection.name,
        )!
        const viaIndex = trace.route.findIndex(
          (routePoint) => routePoint.route_type === "via",
        )
        const via = trace.route[viaIndex]
        const exit = trace.route.at(-1)!
        expect(via?.route_type).toBe("via")
        if (via?.route_type === "via") {
          expect(via.to_layer).toBe(expectedLayer)
          expect(Math.abs(via.x - connection.sourcePoint.x)).toBeCloseTo(0.5)
          expect(Math.abs(via.y - connection.sourcePoint.y)).toBeCloseTo(0.5)
        }
        expect(
          trace.route
            .slice(viaIndex + 1)
            .every(
              (routePoint) =>
                routePoint.route_type !== "wire" ||
                routePoint.layer === "bottom",
            ),
        ).toBe(true)
        expect(exit.route_type).toBe("wire")
        if (exit.route_type === "wire") {
          expect(
            pointIsOutsideInDirection(
              exit,
              sample.sharedBoundary,
              bus.direction,
            ),
          ).toBe(true)
          const exitTrack =
            bus.direction === "left" || bus.direction === "right"
              ? exit.y
              : exit.x
          if (
            exitTrack < componentTrackMinimum ||
            exitTrack > componentTrackMaximum
          ) {
            spreadExitCount++
          }
        }
      }
    }

    expect(spreadExitCount).toBeGreaterThan(
      expectedConnectionCounts[index]! * 0.95,
    )
  }
})
