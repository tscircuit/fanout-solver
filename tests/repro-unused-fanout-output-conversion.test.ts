import { expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import * as outputBuilder from "lib/build-output"
import { FanoutSolver } from "lib/fanout-solver"
import type { AssignmentAttempt, FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("native U22 search constructs output SRJs for discarded partial attempts", async () => {
  const { solverParams: input, solverOptions: options } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/icepi-plane-drop.json.gz", import.meta.url),
      ),
    ).toString(),
  ) as { solverParams: SimpleRouteJson; solverOptions: FanoutSolverOptions }
  const solver = new FanoutSolver(input, options)
  const conversions = spyOn(outputBuilder, "buildOutputSimpleRouteJson")
  solver.solve()
  const best = Reflect.get(solver, "bestAttempt") as AssignmentAttempt
  const output = best.outputSrj
  const conversionCount = conversions.mock.calls.length
  conversions.mockRestore()
  expect(solver.failed).toBe(true)
  expect(() => solver.getOutput()).toThrow()
  expect(solver.attempts).toHaveLength(256)
  expect(best.plans).toHaveLength(23)
  expect(best.outputSrj).toBe(output)
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: output,
    clearance: solver.config.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc).toMatchObject({ valid: true, issues: [] })

  const boundary = options.sharedBoundary
  if (!boundary) throw new Error("Captured U22 fanout boundary is missing")
  const graphics = visualizeSimpleRouteJson({
    ...output,
    bounds: boundary,
    connections: [],
  })
  graphics.texts = [
    {
      x: boundary.minX,
      y: boundary.maxY + 0.8,
      text: `iCE/Pi U22: ${best.plans.length}/32 partial escapes; ${drc.checkedViaCount} vias; 256 assignments`,
      fontSize: 0.25,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: boundary.minX,
      y: boundary.maxY + 0.3,
      text: `Output SRJs constructed: ${conversionCount}`,
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
