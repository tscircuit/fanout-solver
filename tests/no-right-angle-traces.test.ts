import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset02 } from "../datasets/dataset02"

test("post-processing chamfers every same-layer corner away from 90 degrees", () => {
  const sample = fanoutDataset02.at(-1)!
  const solver = new FanoutSolver(sample.simpleRouteJson, sample.solverOptions)
  solver.solve()
  let cornerCount = 0

  for (const trace of solver.getOutput().fanoutTraces) {
    let wireRun: Array<{ x: number; y: number; layer: string }> = []
    for (const routePoint of trace.route) {
      if (routePoint.route_type !== "wire") {
        wireRun = []
        continue
      }
      if (wireRun.at(-1)?.layer !== routePoint.layer) {
        wireRun = []
      }
      wireRun.push(routePoint)
      if (wireRun.length < 3) continue
      const start = wireRun.at(-3)!
      const corner = wireRun.at(-2)!
      const end = wireRun.at(-1)!
      const incoming = {
        x: corner.x - start.x,
        y: corner.y - start.y,
      }
      const outgoing = {
        x: end.x - corner.x,
        y: end.y - corner.y,
      }
      const incomingLength = Math.hypot(incoming.x, incoming.y)
      const outgoingLength = Math.hypot(outgoing.x, outgoing.y)
      if (incomingLength < 1e-9 || outgoingLength < 1e-9) continue

      cornerCount++
      const normalizedDot =
        (incoming.x * outgoing.x + incoming.y * outgoing.y) /
        (incomingLength * outgoingLength)
      expect(Math.abs(normalizedDot)).toBeGreaterThan(1e-6)
    }
  }

  expect(cornerCount).toBeGreaterThan(200)
})
