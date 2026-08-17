import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { createFootprinterBenchmarkSrj } from "../datasets/create-footprinter-benchmark"

test("bus layer preferences prioritize fanout assignments", () => {
  const srj = createFootprinterBenchmarkSrj({ gridSize: 6, layerCount: 4 })
  const buses = (srj.buses ?? []).map<FanoutBusSpec>((bus, busIndex) => {
    if (busIndex === 0) {
      return {
        ...bus,
        preferredLayer: "inner2",
        preferredLayers: ["bottom"],
      }
    }
    if (busIndex === 1) {
      return { ...bus, preferredLayers: ["inner1", "bottom"] }
    }
    return bus
  })
  const solver = new FanoutSolver(srj, { buses })

  expect(solver.layerAssignments[0]?.[buses[0]!.busId]).toBe("inner2")
  expect(solver.layerAssignments[0]?.[buses[1]!.busId]).toBe("inner1")

  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.getOutput().busLayerAssignments[buses[0]!.busId]).toBe("inner2")
  expect(solver.getOutput().busLayerAssignments[buses[1]!.busId]).toBe("inner1")
})
