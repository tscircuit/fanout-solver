import { expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import * as geometry from "lib/geometry"
import { fanoutPlansAreMutuallyClear } from "lib/route-bus"
import { fanoutPlansAreClear } from "lib/route-bus/plan-clearance"
import type { AssignmentAttempt, FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("native U22 via clearance preserves physical copper", async () => {
  const { solverParams: input, solverOptions: options } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/icepi-plane-drop.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as { solverParams: SimpleRouteJson; solverOptions: FanoutSolverOptions }
  const boundary = options.sharedBoundary
  if (!boundary) throw new Error("Captured U22 fanout boundary is missing")
  const solver = new FanoutSolver(input, options)
  solver.solve()
  const best = Reflect.get(solver, "bestAttempt") as AssignmentAttempt
  expect(solver.failed).toBe(true)
  expect(() => solver.getOutput()).toThrow()
  expect(best.plans).toHaveLength(19)

  const pointChecks = spyOn(geometry, "distancePointToObstacle")
  const clear = fanoutPlansAreClear({
    plans: best.plans,
    srj: input,
    sharedBoundary: boundary,
    clearance: solver.config.clearance,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: true,
  })
  const pointCheckCount = pointChecks.mock.calls.length
  pointChecks.mockRestore()
  expect(clear).toBe(true)

  const pairChecks = spyOn(geometry, "distance")
  const mutuallyClear = fanoutPlansAreMutuallyClear({
    plans: best.plans,
    srj: input,
    clearance: solver.config.clearance,
    allowSameNetMerges: true,
  })
  const pairCheckCount = pairChecks.mock.calls.length
  pairChecks.mockRestore()
  expect(mutuallyClear).toBe(true)
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: best.outputSrj,
    clearance: solver.config.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc).toMatchObject({ valid: true, checkedViaCount: 11, issues: [] })

  const graphics = visualizeSimpleRouteJson({
    ...best.outputSrj,
    obstacles: input.obstacles,
    bounds: boundary,
    connections: [],
  })
  graphics.texts = [
    {
      x: boundary.minX,
      y: boundary.maxY + 2.5,
      text: `iCE/Pi U22: ${best.plans.length}/32 partial escapes; ${drc.checkedViaCount} vias`,
      fontSize: 0.25,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: boundary.minX,
      y: boundary.maxY + 2,
      text: `Point/obstacle checks: ${pointCheckCount}`,
      fontSize: 0.25,
      color: "#475569",
      anchorSide: "center_left",
    },
    {
      x: boundary.minX,
      y: boundary.maxY + 1.5,
      text: `Via/via checks: ${pairCheckCount}`,
      fontSize: 0.25,
      color: "#475569",
      anchorSide: "center_left",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 1000,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
