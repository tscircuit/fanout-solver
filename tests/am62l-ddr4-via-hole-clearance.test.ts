import { expect, test } from "bun:test"
import { FanoutSolver } from "../lib/fanout-solver"
import type { FanoutSolverOptions } from "../lib/types"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import captured from "./fixtures/am62l-ddr4-soc-fanout.json"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

test("routes the real AM62L DDR4 fanout with drill-hole clearance", async () => {
  // This is the exact SOC_ESCAPE constructor input captured from the real
  // AM62L + x16 DDR4 TSX circuit, including all package obstacles and buses.
  const [inputSrj, options] = captured as unknown as readonly [
    ConstructorParameters<typeof FanoutSolver>[0],
    FanoutSolverOptions,
  ]
  const holeToHoleClearance = (
    inputSrj as typeof inputSrj & {
      minViaHoleEdgeToViaHoleEdgeClearance: number
    }
  ).minViaHoleEdgeToViaHoleEdgeClearance
  expect(holeToHoleClearance).toBe(0.254)

  const solver = new FanoutSolver(inputSrj, {
    ...options,
    maxLayerCombinations: 1,
  })
  solver.solve()

  expect(solver.failed, solver.error ?? undefined).toBe(false)
  expect(solver.solved).toBe(true)
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(49)
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
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
    checkedTraceCount: 49,
    issues: [],
  })
  await expect(
    getPcbSvgFromSrj(inputSrj, routedSrj, { deduplicateTraceIds: true }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 1_800_000)
