import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset01 } from "../datasets/dataset01"

test("dataset01 solves samples containing one through five footprints", () => {
  expect(fanoutDataset01).toHaveLength(5)

  for (let index = 0; index < fanoutDataset01.length; index++) {
    const sample = fanoutDataset01[index]!
    const expectedFootprintCount = index + 1
    const componentIds = new Set(
      sample.simpleRouteJson.obstacles.flatMap((obstacle) =>
        obstacle.componentId ? [obstacle.componentId] : [],
      ),
    )

    expect(sample.id).toBe(
      `sample${String(expectedFootprintCount).padStart(3, "0")}`,
    )
    expect(sample.footprintCount).toBe(expectedFootprintCount)
    expect(componentIds.size).toBe(expectedFootprintCount)
    expect(sample.simpleRouteJson.buses ?? []).toHaveLength(
      expectedFootprintCount * 4,
    )

    const solver = new FanoutSolver(sample.simpleRouteJson)
    expect(
      new Set(solver.preparedBuses.map((bus) => bus.componentId)).size,
    ).toBe(expectedFootprintCount)

    solver.solve()

    expect(solver.failed).toBe(false)
    const output = solver.getOutput()
    expect(output.fanoutTraces).toHaveLength(
      sample.simpleRouteJson.connections.length,
    )
    expect(Object.keys(output.busLayerAssignments)).toHaveLength(
      expectedFootprintCount * 4,
    )
  }
})
