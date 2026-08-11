import { expect, test } from "bun:test"
import { srj29FanoutSamples } from "../datasets/srj29"
import { FanoutSolver } from "../lib/fanout-solver"

test("SRJ29 endpoint completion only retains physically connected DRC-clean copper", () => {
  const sample = srj29FanoutSamples.find(({ id }) => id === "sample001")!
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()

  const output = solver.getOutput()
  expect(output.endpointCompletion).toBeDefined()
  expect(output.endpointCompletion?.drc).toMatchObject({
    valid: true,
    issues: [],
  })
  expect(
    output.endpointCompletion!.connectivity.connectedConnectionCount,
  ).toBeGreaterThanOrEqual(20)
  expect(output.completionTraces.length).toBeGreaterThanOrEqual(20)
  expect(
    output.completionTraces.every((trace) =>
      trace.route.every(
        (routePoint) =>
          routePoint.route_type === "wire" || routePoint.route_type === "via",
      ),
    ),
  ).toBe(true)
}, 60_000)
