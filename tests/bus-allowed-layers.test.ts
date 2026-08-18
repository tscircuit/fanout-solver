import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { createFootprinterBenchmarkSrj } from "../datasets/create-footprinter-benchmark"

const createSrjAndBuses = () => {
  const srj = createFootprinterBenchmarkSrj({ gridSize: 6, layerCount: 4 })
  return {
    srj,
    buses: (srj.buses ?? []).map<FanoutBusSpec>((bus) => ({ ...bus })),
  }
}

test("bus allowedLayers are a hard fanout constraint", () => {
  const { srj, buses } = createSrjAndBuses()
  buses[0] = { ...buses[0]!, allowedLayers: ["inner2"] }
  buses[1] = { ...buses[1]!, allowedLayers: ["inner1"] }
  const solver = new FanoutSolver(srj, { buses })

  for (const assignment of solver.layerAssignments) {
    expect(assignment[buses[0]!.busId]).toBe("inner2")
    expect(assignment[buses[1]!.busId]).toBe("inner1")
  }

  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.getOutput().busLayerAssignments[buses[0]!.busId]).toBe("inner2")
  expect(solver.getOutput().busLayerAssignments[buses[1]!.busId]).toBe("inner1")
})

test("bus allowedLayers are intersected with global escapeLayers", () => {
  const { srj, buses } = createSrjAndBuses()
  buses[0] = {
    ...buses[0]!,
    allowedLayers: ["inner2", "bottom"],
  }
  const solver = new FanoutSolver(srj, {
    buses,
    escapeLayers: ["top", "bottom"],
  })

  for (const assignment of solver.layerAssignments) {
    expect(assignment[buses[0]!.busId]).toBe("bottom")
  }
})

test("bus allowedLayers reject an empty global intersection", () => {
  const { srj, buses } = createSrjAndBuses()
  buses[0] = { ...buses[0]!, allowedLayers: ["inner2"] }

  expect(
    () =>
      new FanoutSolver(srj, {
        buses,
        escapeLayers: ["top", "bottom"],
      }),
  ).toThrow(
    `FanoutSolver: bus "${buses[0]!.busId}" has no allowed layer in escapeLayers`,
  )
})

test("bus allowedLayers reject unavailable board layers", () => {
  const { srj, buses } = createSrjAndBuses()
  buses[0] = { ...buses[0]!, allowedLayers: ["inner3"] }

  expect(() => new FanoutSolver(srj, { buses })).toThrow(
    `FanoutSolver: bus "${buses[0]!.busId}" allows unavailable layer "inner3"`,
  )
})

test("bus allowedLayers cannot be empty", () => {
  const { srj, buses } = createSrjAndBuses()
  buses[0] = { ...buses[0]!, allowedLayers: [] }

  expect(() => new FanoutSolver(srj, { buses })).toThrow(
    `FanoutSolver: bus "${buses[0]!.busId}" must allow at least one layer`,
  )
})
