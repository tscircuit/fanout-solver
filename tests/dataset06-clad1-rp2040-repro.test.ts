import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset06 } from "../datasets/dataset06"

test("dataset06 records the remaining clad1 RP2040 fanout gap", () => {
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
    "FanoutSolver: best layer assignment routed 37/132 connections",
  )
  expect(solver.attempts).toHaveLength(1)
  expect(solver.attempts[0]).toMatchObject({
    routedConnectionCount: 37,
    routedBusCount: 37,
  })
}, 60_000)
