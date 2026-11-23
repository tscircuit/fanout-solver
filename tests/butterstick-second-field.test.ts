import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutRoutePlan, FanoutSolverOptions } from "lib/types"
import { cropGraphicsToBounds } from "./helpers/crop-fanout-region"
import { getViaPadConflicts } from "./helpers/get-via-pad-conflicts"

// This exercises the public solver from the unmodified second-field input,
// without seeding any of the captured partial routes used by the local repro.
test("solves the second RAM region directly after the first routing phase", async () => {
  const fixture = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/butterstick-second-field-local-repair.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  ) as { srj: SimpleRouteJson; options: FanoutSolverOptions }
  const original = JSON.stringify(fixture)
  const solver = new FanoutSolver(fixture.srj, fixture.options)
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 91,
    brokenOutConnectionCount: 91,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(91)
  const attempt = Reflect.get(solver, "bestAttempt") as {
    plans: FanoutRoutePlan[]
  }
  expect(
    getViaPadConflicts(fixture.srj, attempt.plans, solver.config.clearance),
  ).toEqual([])
  expect(JSON.stringify(fixture)).toBe(original)
  await expect(
    getSvgFromGraphicsObject(
      cropGraphicsToBounds(solver.visualize(), fixture.options.sharedBoundary!),
      { backgroundColor: "white", svgWidth: 1100, svgHeight: 750 },
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 300_000)
