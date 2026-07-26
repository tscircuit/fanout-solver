import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createFootprinterBenchmarkSrj } from "../datasets/create-footprinter-benchmark"

test("escape vias sit in the gap between adjacent BGA pads", () => {
  const srj = createFootprinterBenchmarkSrj({ gridSize: 8 })
  const solver = new FanoutSolver(srj)
  solver.solve()
  const output = solver.getOutput()
  const connection = srj.connections.find(
    (candidate) => candidate.name === "BUS_FP01_SOUTH_R04_C04",
  )!
  const sourcePoint = connection.pointsToConnect[0]!
  const trace = output.fanoutTraces.find(
    (candidate) => candidate.connection_name === connection.name,
  )!
  const via = trace.route.find((routePoint) => routePoint.route_type === "via")
  expect(via?.route_type).toBe("via")
  if (via?.route_type !== "via") return

  const padsInColumn = srj.obstacles
    .filter(
      (obstacle) =>
        obstacle.componentId === "central-bga" &&
        Math.abs(obstacle.center.x - sourcePoint.x) < 1e-6,
    )
    .sort((a, b) => a.center.y - b.center.y)
  const sourcePadIndex = padsInColumn.findIndex(
    (obstacle) => Math.abs(obstacle.center.y - sourcePoint.y) < 1e-6,
  )
  const outwardNeighbor = padsInColumn[sourcePadIndex - 1]!

  expect(via.x).toBeCloseTo(sourcePoint.x, 8)
  expect(via.y).toBeLessThan(sourcePoint.y)
  expect(via.y).toBeGreaterThan(outwardNeighbor.center.y)
  expect(via.y).toBeCloseTo((sourcePoint.y + outwardNeighbor.center.y) / 2, 8)
  expect(
    via.y - (outwardNeighbor.center.y + outwardNeighbor.height / 2),
  ).toBeGreaterThanOrEqual(
    (via.via_diameter ?? 0) / 2 + (srj.minViaEdgeToPadEdgeClearance ?? 0),
  )
})
