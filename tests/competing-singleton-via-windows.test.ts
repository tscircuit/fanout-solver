import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createCompetingSingletonViaWindows } from "./fixtures/competing-singleton-via-windows"

test("a signal reroutes around the plane via", async (): Promise<void> => {
  const { input, options } = createCompetingSingletonViaWindows()
  const solver = new FanoutSolver(input, options)
  solver.solve()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    brokenOutConnectionCount: 2,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: output.simpleRouteJson,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })
  const graphics = solver.visualize()
  const routed = Math.max(
    ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
  )
  graphics.texts = [
    {
      x: input.bounds.minX,
      y: input.bounds.maxY + 0.55,
      text: "Signal and ground must share two via openings.",
      fontSize: 0.1,
      anchorSide: "center_left",
      color: "#0f172a",
    },
    {
      x: input.bounds.minX,
      y: input.bounds.maxY + 0.3,
      text: solver.solved
        ? "PASS: Both connections escape without a collision."
        : `FAIL: Only ${routed}/2 connections escape; one is blocked.`,
      fontSize: 0.1,
      anchorSide: "center_left",
      color: solver.solved ? "#166534" : "#b91c1c",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 900,
      svgHeight: 700,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
