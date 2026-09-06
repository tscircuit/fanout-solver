import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { createAm62lCoreProgressiveDramInput } from "./fixtures/create-am62l-core-progressive-dram-input"

test("preserves routing coverage for core's complete AM62L progressive DRAM input", async () => {
  // Unlike the older six-bus fixture, this exact constructor capture retains
  // core's full connectivity lists, all 217 obstacles, and 135 prior traces.
  const { inputSrj, options } = createAm62lCoreProgressiveDramInput()
  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()

  const bestRoutedConnectionCount = Math.max(
    0,
    ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
  )
  expect(solver.solved || solver.failed).toBe(true)
  // The baseline routes 125/143. A faster search must preserve that coverage,
  // and a future complete solution must also meet the original DRC rules.
  expect(bestRoutedConnectionCount).toBeGreaterThanOrEqual(125)
  if (solver.solved) {
    const output = solver.getOutput()
    expect(output.validation).toEqual({
      valid: true,
      checkedConnectionCount: 143,
      brokenOutConnectionCount: 143,
      issues: [],
    })
    expect(
      validateRoutedCopperDrc({
        inputSrj,
        routedSrj: {
          ...output.simpleRouteJson,
          traces: output.fanoutTraces,
        },
        clearance: inputSrj.minViaEdgeToPadEdgeClearance!,
        allowBlindAndBuriedVias: false,
      }),
    ).toMatchObject({ valid: true, checkedTraceCount: 143, issues: [] })
  } else {
    expect(() => solver.getOutput()).toThrow(
      "getOutput() called before a complete fanout was solved",
    )
  }

  const visualization = mergeGraphics(solver.visualize(), {
    texts: [
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 2,
        text: "Core AM62L DRAM · 143 connections · 217 obstacles · 135 prior traces",
        color: "#0f172a",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
      {
        x: inputSrj.bounds.minX,
        y: inputSrj.bounds.maxY + 1,
        text: `Best routed ${bestRoutedConnectionCount}/143 · solved=${solver.solved} · failed=${solver.failed}`,
        color: solver.solved ? "#166534" : "#b91c1c",
        fontSize: 0.6,
        anchorSide: "bottom_left",
      },
    ],
  })
  await expect(getSvgFromGraphicsObject(visualization)).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 300_000)
