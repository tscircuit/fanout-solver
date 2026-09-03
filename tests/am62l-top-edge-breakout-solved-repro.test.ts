import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { createAm62lTopEdgeBreakoutRepro } from "../repros/repro04-am62l-top-edge-breakout.page"

test("routes every AM62L top-edge breakout connection", async () => {
  const { inputSrj, options } = createAm62lTopEdgeBreakoutRepro()
  inputSrj.differentialPairs = []
  options.buses = options.buses?.map((bus) => ({
    ...bus,
    maxLengthSkew: undefined,
  }))

  const solver = new FanoutSolver(inputSrj, options)
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
  expect(output.fanoutTraces).toHaveLength(135)
  expect(output.planeTerminations).toHaveLength(102)
  expect(output.simpleRouteJson.fanoutPlaneConnectivity).toHaveLength(102)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 120_000)
