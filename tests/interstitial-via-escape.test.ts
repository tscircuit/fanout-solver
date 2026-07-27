import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createFootprinterBenchmarkProblem } from "../datasets/create-footprinter-benchmark"

test("oversized vias use four-pad corner interstices instead of pair gaps", () => {
  const problem = createFootprinterBenchmarkProblem({
    boundaryMargin: 4,
    clearance: 0.1,
    footprints: [
      {
        componentId: "corner-via-bga",
        center: { x: 0, y: 0 },
        gridSize: 4,
        rowCount: 4,
        columnCount: 10,
        pitch: 0.4,
        padDiameter: 0.2,
      },
    ],
    layerCount: 2,
    busDirectionMode: "vertical-split",
    maxConnectionsPerBus: 10,
    traceWidth: 0.1,
    viaDiameter: 0.15,
    viaHoleDiameter: 0.1,
  })
  const srj = problem.simpleRouteJson
  const viaDiameter = srj.minViaPadDiameter!
  const clearance = srj.minViaEdgeToPadEdgeClearance!
  const pad = srj.obstacles.find((obstacle) => obstacle.componentId)!
  const xCoordinates = [
    ...new Set(
      srj.obstacles
        .filter((obstacle) => obstacle.componentId === pad.componentId)
        .map((obstacle) => obstacle.center.x),
    ),
  ].sort((a, b) => a - b)
  const pitch = xCoordinates[1]! - xCoordinates[0]!
  const pairGapClearance = pitch / 2 - pad.width / 2
  const cornerClearance = Math.hypot(pitch / 2, pitch / 2) - pad.width / 2
  const requiredViaClearance = viaDiameter / 2 + clearance

  expect(pairGapClearance).toBeLessThan(requiredViaClearance)
  expect(cornerClearance).toBeGreaterThan(requiredViaClearance)

  const solver = new FanoutSolver(srj, {
    compactBusTracks: true,
    componentBounds: problem.componentBounds,
    sharedBoundary: problem.sharedBoundary,
  })
  solver.solve()
  const output = solver.getOutput()
  let interiorViaCount = 0

  for (const bus of solver.preparedBuses) {
    const minX = Math.min(...bus.xCoordinates)
    const maxX = Math.max(...bus.xCoordinates)
    const minY = Math.min(...bus.yCoordinates)
    const maxY = Math.max(...bus.yCoordinates)

    for (const connection of bus.connections) {
      const trace = output.fanoutTraces.find(
        (candidate) => candidate.connection_name === connection.connection.name,
      )!
      const via = trace.route.find(
        (routePoint) => routePoint.route_type === "via",
      )
      if (via?.route_type !== "via") continue
      if (via.x <= minX || via.x >= maxX || via.y <= minY || via.y >= maxY) {
        continue
      }

      interiorViaCount++
      const fourCornerPads = bus.componentObstacles.filter(
        (candidate) =>
          Math.abs(Math.abs(candidate.center.x - via.x) - pitch / 2) < 1e-6 &&
          Math.abs(Math.abs(candidate.center.y - via.y) - pitch / 2) < 1e-6,
      )
      expect(fourCornerPads).toHaveLength(4)
    }
  }

  expect(interiorViaCount).toBe(18)
})
