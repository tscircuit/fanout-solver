import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createAm62lTopEdgeBreakoutRepro } from "../repros/repro04-am62l-top-edge-breakout.page"

test("routes every AM62L top-edge breakout with its original timing constraints", async () => {
  const { inputSrj, options } = createAm62lTopEdgeBreakoutRepro()

  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)

  const output = solver.getOutput()
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 135,
    brokenOutConnectionCount: 135,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(135)
  expect(output.planeTerminations).toHaveLength(102)
  expect(output.simpleRouteJson.fanoutPlaneConnectivity).toHaveLength(102)
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...output.simpleRouteJson, traces: output.fanoutTraces },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 135,
    checkedViaCount: 135,
    issues: [],
  })
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 120_000)
