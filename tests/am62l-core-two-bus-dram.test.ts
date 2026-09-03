import { expect, test } from "bun:test"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import captured from "./fixtures/am62l-core-two-bus-dram.json"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

test("keeps one via per connection when automatic dogbone matching cannot route a byte bus", async () => {
  // DRAM phase from core's repro-am62l-lpddr4-two-bus-bga-fanout test.
  const inputSrj = captured.inputSrj as unknown as ConstructorParameters<
    typeof FanoutSolver
  >[0]
  const options = captured.options as unknown as ConstructorParameters<
    typeof FanoutSolver
  >[1]
  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({
    valid: true,
    brokenOutConnectionCount: 16,
    issues: [],
  })
  expect(output.fanoutTraces).toHaveLength(16)
  for (const trace of output.fanoutTraces) {
    expect(
      trace.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(1)
  }
  const routedSrj = {
    ...output.simpleRouteJson,
    traces: output.fanoutTraces,
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj,
      clearance: inputSrj.minViaEdgeToPadEdgeClearance!,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 16,
    checkedViaCount: 16,
    issues: [],
  })
  await expect(
    getPcbSvgFromSrj(inputSrj, routedSrj, { deduplicateTraceIds: true }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
