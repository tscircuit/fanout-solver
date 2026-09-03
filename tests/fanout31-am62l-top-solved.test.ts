import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { createAm62lRamTopInput } from "../datasets/dataset09"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"

test("routes the complete AM62L RAM-above sample with its timing constraints", async () => {
  const { simpleRouteJson, solverOptions } = createAm62lRamTopInput()
  expect(simpleRouteJson.connections).toHaveLength(135)
  expect(simpleRouteJson.obstacles).toHaveLength(573)
  expect(simpleRouteJson.differentialPairs).toHaveLength(3)
  expect(solverOptions.buses).toHaveLength(111)
  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
    maxLayerCombinations: 1,
  })
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
  expect(
    validateRoutedCopperDrc({
      inputSrj: simpleRouteJson,
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
}, 180_000)
