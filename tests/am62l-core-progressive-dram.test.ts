import { expect, test } from "bun:test"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"
import { getSvgFromGraphicsObject, mergeGraphics } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { createAm62lCoreProgressiveDramInput } from "./fixtures/create-am62l-core-progressive-dram-input"

test("routes every connection in core's complete AM62L progressive DRAM input", async () => {
  // Unlike the older six-bus fixture, this exact constructor capture retains
  // core's full connectivity lists, all 217 obstacles, and 135 prior traces.
  const { inputSrj, options } = createAm62lCoreProgressiveDramInput()
  const solver = new FanoutSolver(inputSrj, options)
  solver.solve()

  const bestRoutedConnectionCount = Math.max(
    0,
    ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
  )
  expect(solver.failed).toBe(false)
  expect(solver.solved).toBe(true)
  expect(solver.attempts).toHaveLength(1)
  expect(bestRoutedConnectionCount).toBe(143)
  const output = solver.getOutput()
  expectStraightOr45Fanout(output.fanoutTraces)
  expect(output.fanoutTraces).toHaveLength(143)
  expect(
    new Set(output.fanoutTraces.map((trace) => trace.connection_name)),
  ).toEqual(new Set(inputSrj.connections.map((connection) => connection.name)))
  expect(output.simpleRouteJson.traces?.slice(0, 135)).toEqual(inputSrj.traces)
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
}, 600_000)
