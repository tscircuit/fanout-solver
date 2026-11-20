import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutRoutePlan, FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { expectSvgSnapshotWithActual } from "./fixtures/expect-svg-snapshot-with-actual"

test("reproduces the complete native ButterStick fanout input", async () => {
  const [input, options] = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/butterstick-native-fanout.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  ) as [SimpleRouteJson, FanoutSolverOptions]
  expect(input.connections).toHaveLength(91)
  expect(input.obstacles).toHaveLength(2733)
  const solver = new FanoutSolver(input, options)
  solver.solve()
  expect(solver.failed).toBe(true)
  const best = Reflect.get(solver, "bestAttempt") as {
    plans: FanoutRoutePlan[]
    outputSrj: SimpleRouteJson
  }
  expect(best.plans).toHaveLength(60)
  const affected = best.plans.find(
    (plan) => plan.connectionName === "source_trace_18",
  )!
  const obliqueSegments = affected.segments.filter(({ start, end }) => {
    const dx = Math.abs(end.x - start.x)
    const dy = Math.abs(end.y - start.y)
    return dx > 1e-7 && dy > 1e-7 && Math.abs(dx - dy) > 1e-7
  })
  expect(obliqueSegments).toHaveLength(1)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: best.outputSrj,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: solver.config.allowBlindAndBuriedVias,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  await expectSvgSnapshotWithActual(
    getSvgFromGraphicsObject(solver.visualize()),
    import.meta.path,
  )
}, 600_000)
