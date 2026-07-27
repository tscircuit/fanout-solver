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
  expect(output.attempts.length).toBeGreaterThan(0)
  expect(output.attempts.length).toBeLessThanOrEqual(256)

  for (const bus of srj.buses ?? []) {
    const expectedLayer = output.busLayerAssignments[bus.busId]
    expect(expectedLayer).toBeDefined()
    const viaUseByConnection: boolean[] = []
    for (const connectionName of bus.connectionNames) {
      const trace = output.fanoutTraces.find(
        (candidate) => candidate.connection_name === connectionName,
      )
      const via = trace?.route.find(
        (routePoint) => routePoint.route_type === "via",
      )
      viaUseByConnection.push(via?.route_type === "via")
      if (via?.route_type === "via") {
        expect(via.to_layer).toBe(expectedLayer)
      }
    }
    expect(new Set(viaUseByConnection).size).toBe(1)
    expect(viaUseByConnection[0]).toBe(expectedLayer !== "top")
  }

  expect(new Set(Object.values(output.busDirections))).toEqual(
    new Set(["up", "down"]),
  )
})
