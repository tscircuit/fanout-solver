import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { distancePointToObstacle } from "lib/geometry"
import { getPlanVias } from "lib/route-bus/plan-copper"
import type { FanoutSolverOptions, AssignmentAttempt } from "lib/types"
import { cropGraphicsToBounds } from "./helpers/crop-fanout-region"

// Native 91-request field from the unchanged ButterStick spaced E2E source.
// Nongeometric circuit metadata is omitted; pad geometry, net identities,
// downstream guidance, trace/via rules, layers and shared boundary are intact.
test("completes all 91 ButterStick escapes with intact buses and original rules", async () => {
  const [input, options] = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/butterstick-spaced-first-field.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  ) as [SimpleRouteJson, FanoutSolverOptions]
  const source = JSON.stringify([input, options])
  const solver = new FanoutSolver(input, options)
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(91)
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 91,
    brokenOutConnectionCount: 91,
    issues: [],
  })
  const attempt = Reflect.get(solver, "bestAttempt") as AssignmentAttempt
  expect(attempt.summary.failedBusIds).toEqual([])
  expect(new Set(attempt.plans.map((p) => p.connectionName)).size).toBe(91)
  const padViolations = attempt.plans.flatMap((plan) =>
    getPlanVias(plan).flatMap((via) =>
      input.obstacles.filter(
        (obstacle) =>
          !obstacle.isCopperPour &&
          (
            obstacle as typeof obstacle & {
              circuitJsonMetadata?: { pcb_smtpad_id?: string }
            }
          ).circuitJsonMetadata?.pcb_smtpad_id &&
          obstacle.layers.some((layer) => via.spanLayers.includes(layer)) &&
          distancePointToObstacle(via.center, obstacle) <
            via.diameter / 2 + solver.config.clearance - 1e-9,
      ),
    ),
  )
  expect(padViolations).toEqual([])
  const oddSegments = attempt.plans.flatMap((plan) =>
    plan.segments.filter((segment) => {
      const x = Math.abs(segment.end.x - segment.start.x),
        y = Math.abs(segment.end.y - segment.start.y)
      return Math.min(x, y, Math.abs(x - y)) > 1e-7
    }),
  )
  expect(oddSegments).toEqual([])
  expect(JSON.stringify([input, options])).toBe(source)
  await expect(
    getSvgFromGraphicsObject(
      cropGraphicsToBounds(solver.visualize(), options.sharedBoundary!),
      { backgroundColor: "white", svgWidth: 1100, svgHeight: 750 },
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 300_000)
