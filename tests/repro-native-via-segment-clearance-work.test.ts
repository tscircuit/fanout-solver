import { expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import * as geometry from "lib/geometry"
import { fanoutPlansAreMutuallyClear } from "lib/route-bus"
import { planIsClearOfPlans } from "lib/route-bus/plan-mutual-clearance"
import type {
  AssignmentAttempt,
  FanoutSolverOptions,
  RoutedSegment,
} from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("native U22 clearance measures distant via-to-trace pairs", async () => {
  const { solverParams: input, solverOptions: options } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/icepi-plane-drop.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as { solverParams: SimpleRouteJson; solverOptions: FanoutSolverOptions }
  const solver = new FanoutSolver(input, options)
  solver.solve()
  const best = Reflect.get(solver, "bestAttempt") as AssignmentAttempt
  expect(solver.failed).toBe(true)
  expect(() => solver.getOutput()).toThrow()
  expect(best.plans).toHaveLength(23)
  const checks = spyOn(geometry, "distancePointToSegment")
  const clear = fanoutPlansAreMutuallyClear({
    plans: best.plans,
    srj: input,
    clearance: solver.config.clearance,
    allowSameNetMerges: true,
  })
  const checkCount = checks.mock.calls.length
  checks.mockRestore()
  expect(clear).toBe(true)
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: best.outputSrj,
    clearance: solver.config.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc).toMatchObject({ valid: true, issues: [] })

  const viaPlan = best.plans.find((plan) => plan.via)
  const tracePlan = best.plans.find((plan) => !plan.via)
  if (!viaPlan?.via || !tracePlan)
    throw new Error("Captured U22 copper is missing")
  const clearanceCases = [
    [0.2, 0.05, 0],
    [0.45, 0.1, 0.1],
    [0.8, 0.3, 0.2],
  ] as const
  for (const [diameter, width, clearance] of clearanceCases) {
    const requiredDistance = (diameter + width) / 2 + clearance
    for (const offset of [-2e-9, 0, 2e-9, 10]) {
      const segment: RoutedSegment = {
        start: { x: -1, y: requiredDistance + offset },
        end: { x: 1, y: requiredDistance + offset },
        layer: "top",
        width,
      }
      const via = { ...viaPlan.via, center: { x: 0, y: 0 }, diameter }
      const viaProbe = { ...viaPlan, segments: [], via }
      const traceProbe = { ...tracePlan, segments: [segment] }
      const expected =
        geometry.distancePointToSegment(
          via.center,
          segment.start,
          segment.end,
        ) >=
        requiredDistance - 1e-9
      for (const [plan, otherPlan] of [
        [viaProbe, traceProbe],
        [traceProbe, viaProbe],
      ]) {
        expect(
          planIsClearOfPlans({
            plan,
            otherPlans: [otherPlan],
            srj: input,
            clearance,
            allowSameNetMerges: false,
          }),
        ).toBe(expected)
      }
    }
  }

  const boundary = options.sharedBoundary
  if (!boundary) throw new Error("Captured U22 fanout boundary is missing")
  const graphics = visualizeSimpleRouteJson({
    ...best.outputSrj,
    obstacles: input.obstacles,
    bounds: boundary,
    connections: [],
  })
  graphics.texts = [
    {
      x: boundary.minX,
      y: boundary.maxY + 2,
      text: `iCE/Pi U22: ${best.plans.length}/32 partial escapes; ${drc.checkedViaCount} vias`,
      fontSize: 0.25,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: boundary.minX,
      y: boundary.maxY + 1.5,
      text: `Exact point-to-segment checks: ${checkCount}`,
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
