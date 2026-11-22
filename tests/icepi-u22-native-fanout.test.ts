import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

test("reproduces the native iCE/Pi U22 fanout", async () => {
  const capture = new URL(
    "./fixtures/icepi-plane-drop.json.gz",
    import.meta.url,
  )
  const { solverParams, solverOptions } = JSON.parse(
    gunzipSync(new Uint8Array(readFileSync(capture))).toString("utf8"),
  )
  const solver = new FanoutSolver(solverParams, solverOptions)
  solver.solve()

  expect(solverParams.connections).toHaveLength(32)
  const routed = Math.max(
    ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
  )
  expect(routed).toBe(23)
  const bestAttempt = Reflect.get(solver, "bestAttempt") as {
    outputSrj: SimpleRouteJson
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: solver.inputSrj,
      routedSrj: bestAttempt.outputSrj,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: solver.config.allowBlindAndBuriedVias,
    }),
  ).toMatchObject({ valid: true, checkedViaCount: 11, issues: [] })
  const graphics = solver.visualize()
  const requestCount = solverParams.connections.length
  const remaining = requestCount - routed
  graphics.texts = [
    {
      x: solverParams.bounds.minX,
      y: solverParams.bounds.maxY + 1.1,
      text: "iCE/Pi U22: Every request must escape the package.",
      fontSize: 0.22,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: solverParams.bounds.minX,
      y: solverParams.bounds.maxY + 0.7,
      text: solver.solved
        ? `PASS: All ${requestCount} requests escape the package.`
        : `FAIL: ${routed}/${requestCount} escape; ${remaining} remain blocked.`,
      fontSize: 0.18,
      color: solver.solved ? "#166534" : "#b91c1c",
      anchorSide: "center_left",
    },
  ]
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 180_000)
