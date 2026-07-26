import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createFootprinterBenchmarkSrj } from "../datasets/create-footprinter-benchmark"

test("footprinter BGA64 benchmark fully escapes", () => {
  const srj = createFootprinterBenchmarkSrj({ gridSize: 8 })
  expect(srj.obstacles).toHaveLength(64)
  expect(srj.connections).toHaveLength(20)

  const solver = new FanoutSolver(srj)
  solver.solve()
  const output = solver.getOutput()

  expect(output.fanoutTraces).toHaveLength(20)
  expect(
    output.fanoutTraces.every((trace) =>
      trace.route.some((routePoint) => routePoint.route_type === "via"),
    ),
  ).toBe(true)
  expect(output.simpleRouteJson.traces).toHaveLength(20)
  expect(output.simpleRouteJson.obstacles).toHaveLength(84)
})
