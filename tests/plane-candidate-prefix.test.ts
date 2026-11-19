import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBusAlternatives } from "lib/route-bus"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("nearby plane sites retain the complete legacy candidate prefix", () => {
  const { input, options } = createTwoViaWindows()
  input.obstacles = input.obstacles.filter(
    (obstacle) => obstacle.componentId === "U1",
  )
  const solver = new FanoutSolver(input, options)
  const ground = solver.preparedBuses.find((bus) => bus.busId === "ground")
  if (!ground) throw new Error("Expected the ground plane request")
  const alternatives = routeBusAlternatives(
    {
      ...solver.config,
      srj: input,
      bus: ground,
      targetLayer: "inner1",
      acceptedPlans: [],
    },
    8,
  )
  expect(
    alternatives.map(([plan]) => {
      const route = plan!.trace.route
      return route
        .slice(0, route.findIndex((point) => point.route_type === "via"))
        .map((point) => `${Number(point.x.toFixed(6))},${point.y}`)
        .join(" ")
    }),
  ).toEqual([
    "0,0 -0.3,0",
    "0,0 -0.9,0",
    "0,0 -0.3,0 -0.9,0",
    "0,0 -0.3,0",
    "0,0 -0.9,0",
    "0,0 -0.3,0 -0.9,0",
    "0,0 -0.3,0",
    "0,0 -0.9,0",
  ])
})
