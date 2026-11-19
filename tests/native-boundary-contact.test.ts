import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiBoundaryContact } from "./fixtures/icepi-boundary-contact"

test("native iCE/Pi boundary contact guides the default escape", async (): Promise<void> => {
  const { srj, solverOptions } = createIcepiBoundaryContact()
  expect(srj.obstacles).toHaveLength(2038)
  expect(srj.nominalTraceWidth).toBe(0.1)
  expect(srj.minViaPadDiameter).toBe(0.45)
  expect(srj.minViaHoleDiameter).toBe(0.2)
  const solver = new FanoutSolver(srj, solverOptions)
  solver.solve()
  const output = solver.solved ? solver.getOutput() : undefined
  const copperDrc = output
    ? validateRoutedCopperDrc({
        inputSrj: srj,
        routedSrj: output.simpleRouteJson,
        clearance: 0.1,
        allowBlindAndBuriedVias: false,
      })
    : undefined
  if (copperDrc) expect(copperDrc.valid).toBe(true)
  const viewport = { minX: 1, maxX: 4.8, minY: 10.3, maxY: 13.2 }
  // Crop only the drawing; every original obstacle participates in routing.
  const graphics = visualizeSimpleRouteJson({
    ...srj,
    obstacles: srj.obstacles.filter(
      (obstacle) =>
        obstacle.center.x >= viewport.minX &&
        obstacle.center.x <= viewport.maxX &&
        obstacle.center.y >= viewport.minY &&
        obstacle.center.y <= viewport.maxY,
    ),
    traces: output?.fanoutTraces ?? [],
  })
  graphics.lines ??= []
  graphics.lines.push({
    points: [
      { x: viewport.minX, y: srj.bounds.minY },
      { x: viewport.maxX, y: srj.bounds.minY },
    ],
    strokeColor: "#334155",
    strokeWidth: 0.015,
    strokeDash: [0.05, 0.05],
    label: "Original shared breakout boundary",
  })
  graphics.texts = [
    {
      x: viewport.minX,
      y: viewport.maxY + 0.7,
      text: `iCE/Pi BALL_A5: ${solver.solved ? 1 : 0}/1 accepted`,
      fontSize: 0.18,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: viewport.minX,
      y: viewport.maxY + 0.4,
      text: `Default direction: ${solver.preparedBuses[0].direction}; target touches bottom boundary`,
      fontSize: 0.13,
      color: "#475569",
      anchorSide: "center_left",
    },
    {
      x: viewport.minX,
      y: viewport.maxY + 0.15,
      text: copperDrc
        ? `Accepted copper: ${copperDrc.checkedViaCount} vias; ${copperDrc.issues.length} DRC issues`
        : "No accepted route",
      fontSize: 0.13,
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
