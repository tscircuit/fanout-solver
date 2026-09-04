import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import capturedSample from "../datasets/fixtures/fanout31-am62l-top-center.json"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"

const fixture = capturedSample as unknown as {
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}

test("adaptively routes the raw dataset31 AM62L top-center sample", async () => {
  const simpleRouteJson = structuredClone(fixture.simpleRouteJson)
  const solverOptions = structuredClone(fixture.solverOptions)
  expect(solverOptions.densePlaneReservationBusIds).toBeUndefined()
  expect(solverOptions.denseUnrestrictedPlaneRoutingBusIds).toBeUndefined()

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
  // The dataset31 benchmark independently enforces its 120-second score
  // deadline. This snapshot test allows additional ARM CI runtime variance.
}, 240_000)
