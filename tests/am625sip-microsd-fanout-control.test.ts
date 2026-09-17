import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createAm625sipMicrosdFanout } from "./fixtures/create-am625sip-microsd-fanout"

test("routes the AM625SiP outer-row microSD control", async () => {
  const { inputSrj, options } = createAm625sipMicrosdFanout({
    includeInnerRow: false,
  })
  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 2,
    brokenOutConnectionCount: 2,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output.simpleRouteJson,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})
