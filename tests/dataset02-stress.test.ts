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

test("Dataset 02 completely breaks out a four-layer BGA400", () => {
  expect(fanoutDataset02).toHaveLength(1)
  const sample = fanoutDataset02[0]!
  const srj = sample.simpleRouteJson
  const padObstacles = srj.obstacles.filter((obstacle) => obstacle.componentId)
  const footprinterString = "bga400_grid20x20_p0.8mm_pad0.3mm_circularpads"

  expect(sample.footprintCount).toBe(1)
  expect(sample.footprinterStrings).toEqual([footprinterString])
  expect(srj.layerCount).toBe(4)
  expect(srj.nominalTraceWidth).toBe(0.1)
  expect(srj.minTraceToPadEdgeClearance).toBe(0.1)
  expect(srj.minViaEdgeToPadEdgeClearance).toBe(0.1)
  expect(srj.minViaPadDiameter).toBe(0.25)
  expect(srj.minViaHoleDiameter).toBe(0.15)
  expect(srj.connections).toHaveLength(400)
  expect(srj.buses).toHaveLength(20)
  expect(padObstacles).toHaveLength(400)

  const componentBounds = Object.values(sample.componentBounds)
  expect(componentBounds).toHaveLength(1)
  expect(sample.sharedBoundary.minX).toBeCloseTo(componentBounds[0]!.minX - 4)
  expect(sample.sharedBoundary.maxX).toBeCloseTo(componentBounds[0]!.maxX + 4)
  expect(sample.sharedBoundary.minY).toBeCloseTo(componentBounds[0]!.minY - 4)
  expect(sample.sharedBoundary.maxY).toBeCloseTo(componentBounds[0]!.maxY + 4)

  const solver = new FanoutSolver(srj, sample.solverOptions)
  solver.solve()
  expect(solver.failed).toBe(false)

  const output = solver.getOutput()
  expect(output.attempts).toHaveLength(1)
  expect(output.fanoutTraces).toHaveLength(400)
  const nonTopGraphicsLines =
    solver
      .visualize()
      .lines?.filter(
        (line) => line.layer !== "z0" && /^z\d+$/.test(line.layer ?? ""),
      ) ?? []
  expect(nonTopGraphicsLines.length).toBeGreaterThan(0)
  expect(
    nonTopGraphicsLines.every(
      (line) => line.strokeColor === "blue" && line.strokeDash === undefined,
    ),
  ).toBe(true)
  expect(
    Object.values(output.busLayerAssignments).filter(
      (layer) => layer === "top",
    ),
  ).toHaveLength(2)
  expect(
    Object.values(output.busLayerAssignments).reduce<Record<string, number>>(
      (counts, layer) => ({
        ...counts,
        [layer]: (counts[layer] ?? 0) + 1,
      }),
      {},
    ),
  ).toEqual({
    top: 2,
    inner1: 6,
    inner2: 6,
    bottom: 6,
  })

  const expectedLayersByDepth = [
    "top",
    "inner1",
    "inner2",
    "bottom",
    "inner1",
    "inner2",
    "bottom",
    "inner1",
    "inner2",
    "bottom",
  ]
  let viaCount = 0
  for (const bus of solver.preparedBuses) {
    const rowNumber = Number(bus.busId.match(/row-(\d+)/)?.[1])
    const depth = bus.direction === "down" ? rowNumber - 1 : 20 - rowNumber
    const expectedLayer = expectedLayersByDepth[depth]!
    expect(output.busLayerAssignments[bus.busId]).toBe(expectedLayer)
    expect(bus.connections).toHaveLength(20)

    const busViaUse: boolean[] = []
    const sourceTrackSpan =
      Math.max(...bus.xCoordinates) - Math.min(...bus.xCoordinates)
    const exitTracks: number[] = []

    for (const connection of bus.connections) {
      const trace = output.fanoutTraces.find(
        (candidate) => candidate.connection_name === connection.connection.name,
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
        expect(Math.abs(via.x - connection.sourcePoint.x)).toBeCloseTo(0)
        expect(Math.abs(via.y - connection.sourcePoint.y)).toBeCloseTo(0.4)
        expect(
          trace.route
            .slice(viaIndex + 1)
            .every(
              (routePoint) =>
                routePoint.route_type !== "wire" ||
                routePoint.layer === expectedLayer,
            ),
        ).toBe(true)
      }

      expect(exit.route_type).toBe("wire")
      if (exit.route_type === "wire") {
        expect(
          pointIsOutsideInDirection(exit, sample.sharedBoundary, bus.direction),
        ).toBe(true)
        exitTracks.push(exit.x)
      }
    }

    expect(new Set(busViaUse).size).toBe(1)
    expect(busViaUse[0]).toBe(expectedLayer !== "top")
    const exitTrackSpan = Math.max(...exitTracks) - Math.min(...exitTracks)
    expect(exitTrackSpan).toBeGreaterThanOrEqual(14.5)
    expect(exitTrackSpan).toBeLessThanOrEqual(16)
    expect(Math.abs(exitTrackSpan - sourceTrackSpan)).toBeLessThanOrEqual(0.8)
  }

  expect(viaCount).toBe(360)
})
