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

test("Dataset 02 fully routes JLCPCB-safe sparse-via two-layer samples", () => {
  const expectedConnectionCounts = [100, 200, 228, 256, 356]
  const expectedBusCounts = [10, 20, 26, 32, 42]
  const expectedViaCounts = [80, 180, 192, 224, 304]
  const expectedTopBusCounts = [2, 2, 4, 4, 6]
  expect(fanoutDataset02).toHaveLength(5)

  for (let index = 0; index < fanoutDataset02.length; index++) {
    const sample = fanoutDataset02[index]!
    const srj = sample.simpleRouteJson
    const padObstacles = srj.obstacles.filter(
      (obstacle) => obstacle.componentId,
    )
    expect(sample.footprintCount).toBe(index + 1)
    expect(srj.layerCount).toBe(2)
    expect(srj.nominalTraceWidth).toBe(0.1)
    expect(srj.minTraceToPadEdgeClearance).toBe(0.1)
    expect(srj.minViaEdgeToPadEdgeClearance).toBe(0.1)
    expect(srj.minViaPadDiameter).toBe(0.4)
    expect(srj.minViaHoleDiameter).toBe(0.2)
    expect(srj.connections).toHaveLength(expectedConnectionCounts[index])
    expect(srj.buses).toHaveLength(expectedBusCounts[index])
    expect(padObstacles).toHaveLength(expectedConnectionCounts[index])
    const componentBounds = Object.values(sample.componentBounds)
    expect(sample.sharedBoundary.minX).toBeCloseTo(
      Math.min(...componentBounds.map((bounds) => bounds.minX)) - 20,
    )
    expect(sample.sharedBoundary.maxX).toBeCloseTo(
      Math.max(...componentBounds.map((bounds) => bounds.maxX)) + 20,
    )
    expect(sample.sharedBoundary.minY).toBeCloseTo(
      Math.min(...componentBounds.map((bounds) => bounds.minY)) - 20,
    )
    expect(sample.sharedBoundary.maxY).toBeCloseTo(
      Math.max(...componentBounds.map((bounds) => bounds.maxY)) + 20,
    )

    const solver = new FanoutSolver(srj, sample.solverOptions)
    solver.solve()
    expect(solver.failed).toBe(false)

    const output = solver.getOutput()
    expect(output.fanoutTraces).toHaveLength(expectedConnectionCounts[index])
    expect(
      Object.values(output.busLayerAssignments).filter(
        (layer) => layer === "top",
      ),
    ).toHaveLength(expectedTopBusCounts[index])

    let viaCount = 0
    let spreadExitCount = 0
    for (const bus of solver.preparedBuses) {
      const expectedLayer = output.busLayerAssignments[bus.busId]
      const busViaUse: boolean[] = []
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
        const usesVia = via?.route_type === "via"
        busViaUse.push(usesVia)
        const exit = trace.route.at(-1)!
        if (via?.route_type === "via") {
          viaCount++
          expect(via.to_layer).toBe(expectedLayer)
          expect(Math.abs(via.x - connection.sourcePoint.x)).toBeCloseTo(0.76)
          expect(Math.abs(via.y - connection.sourcePoint.y)).toBeCloseTo(0.76)
          expect(
            trace.route
              .slice(viaIndex + 1)
              .every(
                (routePoint) =>
                  routePoint.route_type !== "wire" ||
                  routePoint.layer === "bottom",
              ),
          ).toBe(true)
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

      expect(new Set(busViaUse).size).toBe(1)
      expect(busViaUse[0]).toBe(expectedLayer !== "top")
    }

    expect(viaCount).toBe(expectedViaCounts[index])
    expect(spreadExitCount).toBeGreaterThan(expectedViaCounts[index]! * 0.95)
  }
})
