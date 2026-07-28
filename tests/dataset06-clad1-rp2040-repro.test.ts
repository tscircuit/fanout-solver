import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset06 } from "../datasets/dataset06"

test("dataset06 reproduces the incomplete clad1 RP2040 shared-boundary fanout", () => {
  const sample = fanoutDataset06[0]!

  expect(sample.simpleRouteJson.layerCount).toBe(1)
  expect(sample.simpleRouteJson.connections).toHaveLength(132)
  expect(sample.simpleRouteJson.obstacles).toHaveLength(265)
  expect(sample.simpleRouteJson.buses).toHaveLength(132)
  expect(sample.solverOptions).toMatchObject({
    escapeLayers: ["top"],
    singleLayerPushAndShove: false,
    compactBusTracks: true,
    borderDistribution: "even",
    maxLayerCombinations: 1,
  })

  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()

  expect(solver.failed).toBe(true)
  expect(solver.error).toBe(
    "FanoutSolver: best layer assignment routed 35/132 connections",
  )
  expect(solver.attempts).toHaveLength(1)
  expect(solver.attempts[0]).toMatchObject({
    routedConnectionCount: 35,
    routedBusCount: 35,
  })
}, 20_000)
