import { expect, test } from "bun:test"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import captured from "./fixtures/am62l-core-progressive-fanout.json"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

test("routes core's AM62L progressive fanout without widening the layer search", async () => {
  // Store repeated connectivity lists once, then reconstruct the exact captured
  // input, including the other footprint and all 589 physical obstacles.
  const inputSrj = {
    ...captured.inputSrj,
    obstacles: captured.inputSrj.obstacles.map(
      ({ connectedToSuffixIndex, ...obstacle }) => ({
        ...obstacle,
        connectedTo: [
          ...obstacle.connectedTo,
          ...(connectedToSuffixIndex === null
            ? []
            : captured.connectedToSuffixes[connectedToSuffixIndex]!),
        ],
      }),
    ),
  } as unknown as ConstructorParameters<typeof FanoutSolver>[0]
  const options = captured.options as unknown as NonNullable<
    ConstructorParameters<typeof FanoutSolver>[1]
  >
  const solver = new FanoutSolver(inputSrj, {
    ...options,
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
    checkedTraceCount: 135,
    checkedViaCount: 135,
    issues: [],
  })
  await expect(
    getPcbSvgFromSrj(inputSrj, routedSrj, { deduplicateTraceIds: true }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
