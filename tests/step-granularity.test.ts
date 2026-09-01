import { expect, test } from "bun:test"
import { fanoutDataset02 } from "../datasets/dataset02"
import { fanoutDataset06 } from "../datasets/dataset06"
import { FanoutSolver } from "../lib/fanout-solver"

test("step exposes candidate, bus-routing, and max-flow work incrementally", () => {
  const multilayerSample = fanoutDataset02[0]!
  const multilayerSolver = new FanoutSolver(
    multilayerSample.simpleRouteJson,
    multilayerSample.solverOptions,
  )
  const initialVisualization = multilayerSolver.visualize()

  expect(multilayerSolver.layerAssignments).toHaveLength(0)
  multilayerSolver.step()
  expect(multilayerSolver.stats).toMatchObject({
    phase: "discover-candidate-layers",
    busIndex: 1,
    busCount: multilayerSolver.preparedBuses.length,
  })
  expect(multilayerSolver.attempts).toHaveLength(0)
  expect(multilayerSolver.solved).toBe(false)

  for (let guard = 0; guard < 100; guard++) {
    if (multilayerSolver.stats.phase === "route-assignment") break
    multilayerSolver.step()
  }
  expect(multilayerSolver.stats).toMatchObject({
    phase: "route-assignment",
    workUnit: 1,
    workUnitCount: multilayerSolver.preparedBuses.length,
  })
  expect(multilayerSolver.attempts).toHaveLength(0)
  expect(multilayerSolver.visualize()).not.toEqual(initialVisualization)

  multilayerSolver.solve()
  expect(multilayerSolver.solved).toBe(true)
  expect(multilayerSolver.iterations).toBeGreaterThan(
    multilayerSolver.preparedBuses.length,
  )

  const singleLayerSample = fanoutDataset06[0]!
  const singleLayerSolver = new FanoutSolver(
    singleLayerSample.simpleRouteJson,
    singleLayerSample.solverOptions,
  )
  for (let guard = 0; guard < 500; guard++) {
    if (
      singleLayerSolver.stats.phase === "prepare-single-layer-adaptive-exits"
    ) {
      break
    }
    singleLayerSolver.step()
  }
  expect(singleLayerSolver.stats.phase).toBe(
    "prepare-single-layer-adaptive-exits",
  )

  singleLayerSolver.step()
  expect(singleLayerSolver.stats.phase).toBe(
    "route-single-layer-adaptive-exits",
  )
  for (let step = 0; step < 4; step++) {
    singleLayerSolver.step()
    expect(singleLayerSolver.solved).toBe(false)
    expect(singleLayerSolver.stats.phase).toBe(
      "route-single-layer-adaptive-exits",
    )
  }
})
