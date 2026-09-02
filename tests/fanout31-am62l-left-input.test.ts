import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  am62lRamLeftProvenance,
  createAm62lRamLeftInput,
} from "../datasets/dataset08"
import { FanoutSolver } from "../lib/fanout-solver"

test("captures the unmodified fanout31 AM62L RAM-left sample", async () => {
  const { simpleRouteJson, solverOptions } = createAm62lRamLeftInput()
  expect(am62lRamLeftProvenance.commit).toBe(
    "8c73befb36b125c84651c07454a9b940b3c6500a",
  )
  expect(am62lRamLeftProvenance.sample).toBe("samples/11-left-center.tsx")
  expect(simpleRouteJson.connections).toHaveLength(135)
  expect(simpleRouteJson.obstacles).toHaveLength(573)
  expect(simpleRouteJson.layerCount).toBe(8)
  expect(simpleRouteJson.differentialPairs).toHaveLength(3)
  expect(solverOptions.allowBlindAndBuriedVias).toBe(false)
  expect(solverOptions.buses).toHaveLength(111)

  const socPads = simpleRouteJson.obstacles.filter(
    (pad) => pad.componentId === "pcb_component_0",
  )
  const ramPads = simpleRouteJson.obstacles.filter(
    (pad) => pad.componentId === "pcb_component_1",
  )
  expect(socPads).toHaveLength(373)
  expect(ramPads).toHaveLength(200)
  expect(
    socPads.reduce((sum, pad) => sum + pad.center.x, 0) / socPads.length,
  ).toBe(0)
  expect(
    ramPads.reduce((sum, pad) => sum + pad.center.x, 0) / ramPads.length,
  ).toBe(-17)

  const signalBuses = solverOptions.buses!.filter(
    (bus) => bus.termination?.type !== "plane",
  )
  expect(signalBuses).toHaveLength(9)
  expect(
    solverOptions.buses!.filter((bus) => bus.termination?.type === "plane"),
  ).toHaveLength(102)
  expect(
    signalBuses.reduce((count, bus) => count + bus.connectionNames.length, 0),
  ).toBe(33)
  expect(
    signalBuses.filter((bus) => bus.maxLengthSkew !== undefined),
  ).toHaveLength(6)
  for (const bus of signalBuses) {
    expect(bus.exitPosition?.startsWith("leftside_")).toBe(true)
    expect(Object.keys(bus.connectionExitTargets ?? {})).toHaveLength(
      bus.connectionNames.length,
    )
    for (const target of Object.values(bus.connectionExitTargets ?? {})) {
      expect(target.x).toBeLessThan(solverOptions.sharedBoundary!.minX)
    }
  }

  const solver = new FanoutSolver(simpleRouteJson, solverOptions)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})
