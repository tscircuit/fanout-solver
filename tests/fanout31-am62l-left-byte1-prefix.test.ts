import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { createAm62lRamLeftSubset } from "../datasets/dataset08"
import { FanoutSolver } from "../lib/fanout-solver"

test("routes all eight BYTE1 connections in the RAM-left sample", async () => {
  const { simpleRouteJson, solverOptions } = createAm62lRamLeftSubset({
    busIds: ["DDR_BYTE1"],
    connectionLimit: 8,
  })
  solverOptions.maxLayerCombinations = 1
  expect(simpleRouteJson.obstacles).toHaveLength(573)
  expect(solverOptions.buses![0]!.maxLengthSkew).toBe(14.5)
  expect(
    simpleRouteJson.connections.some(
      (connection) => connection.name === "breakout:pcb_breakout_point_13",
    ),
  ).toBe(true)
  const solver = new FanoutSolver(simpleRouteJson, solverOptions)
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.getOutput().validation).toEqual({
    valid: true,
    checkedConnectionCount: 8,
    brokenOutConnectionCount: 8,
    issues: [],
  })
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 120_000)
