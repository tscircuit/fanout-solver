import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  type GraphicsObject,
  getSvgFromGraphicsObject,
  mergeGraphics,
} from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

const focusOnBounds = (
  graphics: GraphicsObject,
  bounds: SimpleRouteJson["bounds"],
): GraphicsObject => {
  const contains = ({ x, y }: { x: number; y: number }) =>
    x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY

  return {
    lines: graphics.lines
      ?.map((line) => ({
        ...line,
        points: line.points.filter(contains),
      }))
      .filter((line) => line.points.length >= 2),
    circles: graphics.circles?.filter((circle) => contains(circle.center)),
    points: graphics.points?.filter(contains),
  }
}

test("reproduces the LT8912B mixed-edge fanout failure", async () => {
  const fixtureUrl = new URL(
    "./fixtures/t113-lt8912b-mixed-edge-fanout/input.srj.json.gz",
    import.meta.url,
  )
  const input = JSON.parse(
    gunzipSync(readFileSync(fixtureUrl)).toString(),
  ) as SimpleRouteJson
  const solver = new FanoutSolver(input, {
    sharedBoundary: input.bounds,
    borderDistribution: "even",
    compactBusTracks: true,
  })

  solver.solve()

  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  const sourceComponentIds = new Set(
    solver.preparedBuses.map((bus) => bus.componentId),
  )
  const focusedVisualization = mergeGraphics(
    visualizeSimpleRouteJson({
      ...input,
      obstacles: input.obstacles.filter(
        (obstacle) =>
          obstacle.componentId && sourceComponentIds.has(obstacle.componentId),
      ),
      traces: [],
    }),
    focusOnBounds(solver.visualize(), input.bounds),
  )
  await expect(
    getSvgFromGraphicsObject(focusedVisualization).replace(/[ \t]+$/gm, ""),
  ).toMatchSvgSnapshot(import.meta.path)
})
