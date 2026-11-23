import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  computeTransformFromViewbox,
  getBounds,
  getSvgFromGraphicsObject,
} from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { getPlanVias } from "lib/route-bus/plan-copper"
import type { AssignmentAttempt, FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { applyToPoint } from "transformation-matrix"

test("routes the native iCE/Pi spaced automatic handoffs", async () => {
  const capture: {
    solverParams: SimpleRouteJson
    solverOptions: FanoutSolverOptions
  } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/icepi-spaced-native-fanout.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  )
  const solver = new FanoutSolver(capture.solverParams, capture.solverOptions)
  solver.solve()
  const best = Reflect.get(solver, "bestAttempt") as AssignmentAttempt | null
  if (!best)
    throw new Error("The native fanout produced no completed assignment")

  expect(capture.solverParams.connections).toHaveLength(92)
  expect(solver.failed).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: solver.inputSrj,
      routedSrj: best.outputSrj,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: solver.config.allowBlindAndBuriedVias,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  const viaCount = best.plans.flatMap(getPlanVias).length
  const graphics = visualizeSimpleRouteJson({
    ...best.outputSrj,
    connections: [],
  })
  graphics.texts = [
    ...(graphics.texts ?? []),
    {
      x: capture.solverParams.bounds.minX,
      y: capture.solverParams.bounds.maxY + 0.7,
      text: `iCE/Pi spaced: ${best.plans.length}/92 pad escapes; ${viaCount} vias`,
      fontSize: 0.28,
      color: "#0f172a",
      anchorSide: "bottom_left",
    },
  ]
  const svg = getSvgFromGraphicsObject(graphics, {
    backgroundColor: "white",
    svgWidth: 1000,
    svgHeight: 700,
  })
  await expect(svg).toMatchSvgSnapshot(import.meta.path)

  // Zoom the same native drawing; do not change or omit routed copper.
  const boardToSvg = computeTransformFromViewbox(
    getBounds(graphics),
    1000,
    700,
    { yFlip: true },
  )
  const topLeft = applyToPoint(boardToSvg, { x: 18.7, y: 19.7 })
  const bottomRight = applyToPoint(boardToSvg, { x: 24.4, y: 14.2 })
  const width = bottomRight.x - topLeft.x
  const height = bottomRight.y - topLeft.y
  const sourceChannelsSvg = svg
    .replace(
      'width="1000" height="700"',
      `width="1000" height="${(1000 * height) / width}"`,
    )
    .replace(
      'viewBox="0 0 1000 700"',
      `viewBox="${topLeft.x} ${topLeft.y} ${width} ${height}"`,
    )
    .replace(
      '<rect width="100%" height="100%"',
      `<rect x="${topLeft.x}" y="${topLeft.y}" width="${width}" height="${height}"`,
    )
  await expect(sourceChannelsSvg).toMatchSvgSnapshot(
    import.meta.path,
    "source-channels",
  )
}, 600_000)
