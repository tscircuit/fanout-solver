import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { createFootprinterBenchmarkSrj } from "../datasets/create-footprinter-benchmark"

test("visual regression: bus allowedLayers constrain fanout layers", async () => {
  const srj = createFootprinterBenchmarkSrj({ gridSize: 6, layerCount: 4 })
  const buses = (srj.buses ?? []).map<FanoutBusSpec>((bus) => ({
    ...bus,
    allowedLayers: [bus.busId.includes(":south:") ? "inner2" : "inner1"],
  }))
  const solver = new FanoutSolver(srj, { buses })

  solver.solve()

  expect(solver.solved).toBe(true)
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})
