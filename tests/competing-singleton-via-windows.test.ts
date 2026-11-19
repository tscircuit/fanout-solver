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
      y: input.bounds.maxY + 0.22,
      text: `Plane and boundary escape · ${routed}/2 routed`,
      fontSize: 0.12,
      anchorSide: "center_left",
      color: "#0f172a",
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
