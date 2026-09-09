import { expect, test } from "bun:test"
import { expectSvgSnapshotWithActual } from "./fixtures/expect-svg-snapshot-with-actual"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"
import { createAm62lRamLeftSubset } from "../datasets/dataset08"
import { FanoutSolver } from "../lib/fanout-solver"

test("routes the RAM-left address/control bus with all 102 plane drops", async () => {
  const { simpleRouteJson, solverOptions } = createAm62lRamLeftSubset({
    busIds: ["planes", "DDR_ADDR_CTRL"],
  })
  expect(simpleRouteJson.obstacles).toHaveLength(573)
  expect(
    solverOptions.buses?.find((bus) => bus.busId === "DDR_ADDR_CTRL")
      ?.maxLengthSkew,
  ).toBe(15)
  const solver = new FanoutSolver(simpleRouteJson, solverOptions)
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expectStraightOr45Fanout(output.fanoutTraces)
  expect(
    validateRoutedCopperDrc({
      inputSrj: simpleRouteJson,
      routedSrj: { ...output.simpleRouteJson, traces: output.fanoutTraces },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 110, issues: [] })
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 110,
    brokenOutConnectionCount: 110,
    issues: [],
  })
  expect(output.planeTerminations).toHaveLength(102)
  await expectSvgSnapshotWithActual(
    getSvgFromGraphicsObject(solver.visualize()),
    import.meta.path,
  )
}, 120_000)
