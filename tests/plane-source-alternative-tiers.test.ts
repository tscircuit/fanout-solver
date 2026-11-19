import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBus, routeBusAlternatives } from "lib/route-bus"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("plane alternatives preserve a legacy winner and expose neighboring sites", () => {
  const { input, options } = createTwoViaWindows()
  const solver = new FanoutSolver(input, options)
  const ground = solver.preparedBuses.find((bus) => bus.busId === "ground")
  if (!ground) throw new Error("Expected the ground plane request")
  const params = {
    ...solver.config,
    srj: input,
    bus: { ...ground, requestedDirection: undefined },
    targetLayer: "inner1",
    acceptedPlans: [],
  }
  const winner = routeBus(params)
  expect(winner?.[0]!.via?.center).toEqual({ x: 0.3, y: 0 })
  const alternatives = routeBusAlternatives(params, 2)
  expect(alternatives).toHaveLength(2)
  expect(alternatives[0]![0]!.trace.route).toEqual(winner![0]!.trace.route)
  expect(alternatives[1]![0]!.via?.center).toEqual({ x: -0.24, y: 0.3 })
})
