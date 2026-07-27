import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { getCopperLayerColor } from "lib/layer-colors"
import type { Bounds, FanoutDirection, Point2D } from "lib/types"
import { fanoutDataset02 } from "../datasets/dataset02"

function pointIsOnBoundaryInDirection(
  point: Point2D,
  bounds: Bounds,
  direction: FanoutDirection,
): boolean {
  const epsilon = 1e-6
  switch (direction) {
    case "left":
      return (
        Math.abs(point.x - bounds.minX) <= epsilon &&
        point.y >= bounds.minY - epsilon &&
        point.y <= bounds.maxY + epsilon
      )
    case "right":
      return (
        Math.abs(point.x - bounds.maxX) <= epsilon &&
        point.y >= bounds.minY - epsilon &&
        point.y <= bounds.maxY + epsilon
      )
    case "up":
      return (
        Math.abs(point.y - bounds.maxY) <= epsilon &&
        point.x >= bounds.minX - epsilon &&
        point.x <= bounds.maxX + epsilon
      )
    case "down":
      return (
        Math.abs(point.y - bounds.minY) <= epsilon &&
        point.x >= bounds.minX - epsilon &&
        point.x <= bounds.maxX + epsilon
      )
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
  expect(srj.buses).toHaveLength(40)
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
  const layerGraphicsLines =
    solver
      .visualize()
      .lines?.filter((line) => /^z\d+$/.test(line.layer ?? "")) ?? []
  const visualizedLayerColors = new Set<string>()
  for (let layerIndex = 0; layerIndex < srj.layerCount; layerIndex++) {
    const layerLines = layerGraphicsLines.filter(
      (line) => line.layer === `z${layerIndex}`,
    )
    const expectedColor = getCopperLayerColor(layerIndex)
    expect(layerLines.length).toBeGreaterThan(0)
    expect(
      layerLines.every(
        (line) =>
          line.strokeColor === expectedColor && line.strokeDash === undefined,
      ),
    ).toBe(true)
    visualizedLayerColors.add(expectedColor)
  }
  expect(visualizedLayerColors.size).toBe(4)
  expect(
    Object.values(output.busLayerAssignments).filter(
      (layer) => layer === "top",
    ),
  ).toHaveLength(4)
  expect(
    Object.values(output.busLayerAssignments).reduce<Record<string, number>>(
      (counts, layer) => ({
        ...counts,
        [layer]: (counts[layer] ?? 0) + 1,
      }),
      {},
    ),
  ).toEqual({
    top: 4,
    inner1: 12,
    inner2: 12,
    bottom: 12,
  })
  expect(
    solver.preparedBuses.reduce<Record<FanoutDirection, number>>(
      (counts, bus) => ({
        ...counts,
        [bus.direction]: counts[bus.direction] + 1,
      }),
      { left: 0, right: 0, up: 0, down: 0 },
    ),
  ).toEqual({ left: 10, right: 10, up: 10, down: 10 })
  expect(
    solver.preparedBuses.reduce<Record<FanoutDirection, number>>(
      (counts, bus) => ({
        ...counts,
        [bus.direction]: counts[bus.direction] + bus.connections.length,
      }),
      { left: 0, right: 0, up: 0, down: 0 },
    ),
  ).toEqual({ left: 100, right: 100, up: 100, down: 100 })

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
    const horizontal = bus.direction === "left" || bus.direction === "right"
    const directionalCoordinates = horizontal
      ? bus.xCoordinates
      : bus.yCoordinates
    const directionalPitch = horizontal ? bus.pitchX : bus.pitchY
    const averageDirectionalSource =
      bus.connections.reduce(
        (sum, connection) =>
          sum +
          (horizontal ? connection.sourcePoint.x : connection.sourcePoint.y),
        0,
      ) / bus.connections.length
    const outwardCoordinate =
      bus.direction === "right" || bus.direction === "up"
        ? Math.max(...directionalCoordinates)
        : Math.min(...directionalCoordinates)
    const depth = Math.round(
      Math.abs(averageDirectionalSource - outwardCoordinate) / directionalPitch,
    )
    const expectedLayer = expectedLayersByDepth[depth]!
    expect(output.busLayerAssignments[bus.busId]).toBe(expectedLayer)

    const busViaUse: boolean[] = []
    const sourceTracks = bus.connections.map((connection) =>
      horizontal ? connection.sourcePoint.y : connection.sourcePoint.x,
    )
    const sourceTrackSpan =
      Math.max(...sourceTracks) - Math.min(...sourceTracks)
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
        expect(Math.abs(via.x - connection.sourcePoint.x)).toBeCloseTo(
          horizontal ? 0.4 : 0,
        )
        expect(Math.abs(via.y - connection.sourcePoint.y)).toBeCloseTo(
          horizontal ? 0 : 0.4,
        )
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
          pointIsOnBoundaryInDirection(
            exit,
            sample.sharedBoundary,
            bus.direction,
          ),
        ).toBe(true)
        exitTracks.push(horizontal ? exit.y : exit.x)
      }
    }

    expect(new Set(busViaUse).size).toBe(1)
    expect(busViaUse[0]).toBe(expectedLayer !== "top")
    const exitTrackSpan = Math.max(...exitTracks) - Math.min(...exitTracks)
    expect(Math.abs(exitTrackSpan - sourceTrackSpan)).toBeLessThanOrEqual(0.8)
  }

  expect(viaCount).toBe(324)
})
