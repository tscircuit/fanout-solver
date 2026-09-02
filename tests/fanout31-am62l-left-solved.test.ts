import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { createAm62lRamLeftInput } from "../datasets/dataset08"
import { FanoutSolver } from "../lib/fanout-solver"

test("routes the complete AM62L RAM-left sample with its timing constraints", async () => {
  const { simpleRouteJson, solverOptions } = createAm62lRamLeftInput()
  expect(simpleRouteJson.connections).toHaveLength(135)
  expect(simpleRouteJson.obstacles).toHaveLength(573)
  expect(simpleRouteJson.differentialPairs).toHaveLength(3)
  expect(solverOptions.buses).toHaveLength(111)
  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
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
  expect(output.planeTerminations).toHaveLength(102)
  expect(output.fanoutTraces).toHaveLength(135)
  const reset = output.fanoutTraces.find(
    (trace) => trace.connection_name === "breakout:pcb_breakout_point_20",
  )!
  const resetVias = reset.route.filter((point) => point.route_type === "via")
  expect(resetVias).toHaveLength(1)
  expect(resetVias[0]!.from_layer).toBe("top")
  expect(resetVias[0]!.to_layer).toBe("inner6")
  // RESET escapes on its source layer before changing layers outside the BGA.
  expect(resetVias[0]!.x).toBeLessThan(-5.5)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 180_000)
