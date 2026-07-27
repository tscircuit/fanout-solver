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

test("Dataset 02 fully routes close 0.4 mm pitch two-layer samples", () => {
  const expectedConnectionCounts = [40, 80, 120, 160, 200]
  const expectedBusCounts = [4, 8, 12, 16, 20]
  const expectedViaCounts = [20, 40, 60, 80, 100]
  const expectedTopBusCounts = [2, 4, 6, 8, 10]
  const footprinterString = "bga40_grid10x4_p0.4mm_pad0.2mm_circularpads"
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
    expect(srj.minViaPadDiameter).toBe(0.15)
    expect(srj.minViaHoleDiameter).toBe(0.1)
    expect(sample.footprinterStrings).toEqual(
      Array.from({ length: index + 1 }, () => footprinterString),
    )
    expect(srj.connections).toHaveLength(expectedConnectionCounts[index])
    expect(srj.buses).toHaveLength(expectedBusCounts[index])
    expect(padObstacles).toHaveLength(expectedConnectionCounts[index])
    const componentBounds = Object.values(sample.componentBounds)
    expect(sample.sharedBoundary.minX).toBeCloseTo(
      Math.min(...componentBounds.map((bounds) => bounds.minX)) - 4,
    )
    expect(sample.sharedBoundary.maxX).toBeCloseTo(
      Math.max(...componentBounds.map((bounds) => bounds.maxX)) + 4,
    )
    expect(sample.sharedBoundary.minY).toBeCloseTo(
      Math.min(...componentBounds.map((bounds) => bounds.minY)) - 4,
    )
    expect(sample.sharedBoundary.maxY).toBeCloseTo(
      Math.max(...componentBounds.map((bounds) => bounds.maxY)) + 4,
    )
    if (componentBounds.length > 1) {
      const leftToRight = componentBounds.toSorted((a, b) => a.minX - b.minX)
      for (
        let footprintIndex = 1;
        footprintIndex < leftToRight.length;
        footprintIndex++
      ) {
        expect(
          leftToRight[footprintIndex]!.minX -
            leftToRight[footprintIndex - 1]!.maxX,
        ).toBeCloseTo(0.6)
      }
    }

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
    for (const bus of solver.preparedBuses) {
      const expectedLayer = output.busLayerAssignments[bus.busId]
      const busViaUse: boolean[] = []
      const perpendicularCoordinates =
        bus.direction === "left" || bus.direction === "right"
          ? bus.yCoordinates
          : bus.xCoordinates
      const sourceTrackSpan =
        Math.max(...perpendicularCoordinates) -
        Math.min(...perpendicularCoordinates)
      const exitTracks: number[] = []

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
          expect(Math.abs(via.x - connection.sourcePoint.x)).toBeCloseTo(0.2)
          expect(Math.abs(via.y - connection.sourcePoint.y)).toBeCloseTo(0.2)
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
          exitTracks.push(exitTrack)
        }
      }

      expect(new Set(busViaUse).size).toBe(1)
      expect(busViaUse[0]).toBe(expectedLayer !== "top")
      expect(Math.max(...exitTracks) - Math.min(...exitTracks)).toBeCloseTo(
        (bus.connections.length - 1) * 0.2,
      )
      expect(Math.max(...exitTracks) - Math.min(...exitTracks)).toBeLessThan(
        sourceTrackSpan,
      )
    }

    expect(viaCount).toBe(expectedViaCounts[index])
  }
})
