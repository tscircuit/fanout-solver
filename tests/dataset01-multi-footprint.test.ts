import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset01 } from "../datasets/dataset01"

test("dataset01 solves samples containing one through five footprints", () => {
  expect(fanoutDataset01).toHaveLength(5)
  const expectedConnectionCounts = [64, 100, 136, 200, 236]
  const expectedBusCounts = [8, 14, 20, 28, 34]

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
    expect(sample.simpleRouteJson.connections).toHaveLength(
      expectedConnectionCounts[index],
    )
    expect(sample.simpleRouteJson.connections).toHaveLength(
      sample.simpleRouteJson.obstacles.length,
    )
    expect(sample.simpleRouteJson.buses ?? []).toHaveLength(
      expectedBusCounts[index],
    )
    expect(
      new Set(
        sample.simpleRouteJson.connections.map(
          (connection) => connection.pointsToConnect[0]!.pointId,
        ),
      ).size,
    ).toBe(sample.simpleRouteJson.obstacles.length)

    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    expect(
      new Set(solver.preparedBuses.map((bus) => bus.componentId)).size,
    ).toBe(expectedFootprintCount)
    expect(
      solver.preparedBuses.every(
        (bus) =>
          JSON.stringify(bus.sharedBoundary) ===
          JSON.stringify(sample.sharedBoundary),
      ),
    ).toBe(true)

    solver.solve()

    expect(solver.failed).toBe(false)
    const output = solver.getOutput()
    expect(output.fanoutTraces).toHaveLength(
      sample.simpleRouteJson.connections.length,
    )
    expect(Object.keys(output.busLayerAssignments)).toHaveLength(
      expectedBusCounts[index],
    )
  }
})
