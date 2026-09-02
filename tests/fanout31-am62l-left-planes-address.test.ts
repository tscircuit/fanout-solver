import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
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
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 110,
    brokenOutConnectionCount: 110,
    issues: [],
  })
  expect(output.planeTerminations).toHaveLength(102)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 120_000)
