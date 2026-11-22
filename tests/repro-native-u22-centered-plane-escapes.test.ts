import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { AssignmentAttempt } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("native U22 fanout uses the empty positions inside its pad field", async () => {
  const { solverParams, solverOptions } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/icepi-plane-drop.json.gz", import.meta.url),
      ),
    ).toString(),
  )
  const solver = new FanoutSolver(solverParams, solverOptions)
  solver.solve()
  const attempt = Reflect.get(solver, "bestAttempt") as AssignmentAttempt
  expect(attempt.plans).toHaveLength(19)
  const drc = validateRoutedCopperDrc({
    inputSrj: solverParams,
    routedSrj: attempt.outputSrj,
    clearance: solver.config.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc).toMatchObject({ valid: true, issues: [] })

  const graphics = visualizeSimpleRouteJson({
    ...attempt.outputSrj,
    obstacles: solverParams.obstacles,
    bounds: solverOptions.sharedBoundary,
    connections: [],
  })
  graphics.texts = [
    {
      x: solverOptions.sharedBoundary.minX,
      y: solverOptions.sharedBoundary.maxY + 1,
      text: `iCE/Pi U22: ${attempt.plans.length}/32 escapes; ${drc.checkedViaCount} vias`,
      fontSize: 0.3,
      color: "#0f172a",
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
