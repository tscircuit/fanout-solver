import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("a bent plane escape leaves a through-via window for the boundary signal", async () => {
  const { input, options } = createTwoViaWindows()
  const solver = new FanoutSolver(input, options)
  solver.solve()
  expect(solver.solved).toBe(true)

  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    brokenOutConnectionCount: 2,
    issues: [],
  })
  expect(output.busLayerAssignments).toEqual({
    ground: "inner1",
    signal: "bottom",
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
  graphics.texts = [
    ...(graphics.texts ?? []),
    {
      x: input.bounds.minX,
      y: input.bounds.maxY + 0.22,
      anchorSide: "center_left",
      fontSize: 0.12,
      color: "#0f172a",
      text: `Ground plane and boundary signal · ${output.fanoutTraces.length}/2 routed`,
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, { backgroundColor: "white" }),
  ).toMatchSvgSnapshot(import.meta.path)
})
