import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import fixture from "./fixtures/osm-s-am62l-carrier-fanout.json"
import type {
  FanoutSolverOptions,
  SimpleRouteJsonWithFanoutPlanes,
} from "lib/types"

test("routes every OSM-S AM62L carrier fanout connection", async () => {
  const [inputSrj, options] = fixture.constructorArgs as unknown as [
    SimpleRouteJsonWithFanoutPlanes,
    FanoutSolverOptions,
  ]
  const solver = new FanoutSolver(inputSrj, options)

  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    checkedConnectionCount: 96,
    brokenOutConnectionCount: 96,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(96)
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...output.simpleRouteJson, traces: output.fanoutTraces },
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 30_000)
