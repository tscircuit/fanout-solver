import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import capturedFixture from "./fixtures/am62l-east-orbit-all-signals-repro.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

test("routes every AM62L DDR bus in the east-orbit fanout", async () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  solver.solve()

  expect(fixture.options.buses?.map((bus) => bus.busId)).toEqual([
    "DDR_BYTE0",
    "DDR_BYTE1",
    "DDR_ADDR_CTRL",
    "DDR_CLOCK",
    "DDR_DQS0",
    "DDR_DQS1",
    "DDR_RESET",
    "DDR_DMI0",
    "DDR_DMI1",
  ])
  expect(fixture.inputSrj.connections).toHaveLength(18)
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)

  const output = solver.getOutput()
  const expectedConnectionNames = fixture.options.buses!.flatMap(
    (bus) => bus.connectionNames,
  )
  expect(output.fanoutTraces).toHaveLength(18)
  expect(
    output.fanoutTraces.map((trace) => trace.connection_name).toSorted(),
  ).toEqual(expectedConnectionNames.toSorted())
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 18,
    brokenOutConnectionCount: 18,
    issues: [],
  })

  for (const trace of output.fanoutTraces) {
    expect(
      trace.route.filter((routePoint) => routePoint.route_type === "via"),
    ).toHaveLength(1)
  }

  expect(
    validateRoutedCopperDrc({
      inputSrj: fixture.inputSrj,
      routedSrj: output.simpleRouteJson,
      clearance:
        fixture.options.clearance ??
        fixture.inputSrj.minViaEdgeToPadEdgeClearance ??
        fixture.inputSrj.minTraceToPadEdgeClearance ??
        fixture.inputSrj.minTraceWidth,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 18,
    checkedViaCount: 18,
    issues: [],
  })

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 60_000)
