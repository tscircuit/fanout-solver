import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createFootprinterBenchmarkSrj } from "../datasets/create-footprinter-benchmark"

test("each bus escapes in one direction and onto one layer", () => {
  const srj = createFootprinterBenchmarkSrj({ gridSize: 8 })
  const solver = new FanoutSolver(srj)
  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(srj.connections.length)
  expect(output.attempts).toHaveLength(81)

  for (const bus of srj.buses ?? []) {
    const expectedLayer = output.busLayerAssignments[bus.busId]
    expect(expectedLayer).toBeDefined()
    for (const connectionName of bus.connectionNames) {
      const trace = output.fanoutTraces.find(
        (candidate) => candidate.connection_name === connectionName,
      )
      const via = trace?.route.find(
        (routePoint) => routePoint.route_type === "via",
      )
      expect(via?.route_type).toBe("via")
      if (via?.route_type === "via") {
        expect(via.to_layer).toBe(expectedLayer)
      }
    }
  }

  expect(output.busDirections).toEqual({
    "central-bga:north": "up",
    "central-bga:east": "right",
    "central-bga:south": "down",
    "central-bga:west": "left",
  })
})
