import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { getBusRouteChoices } from "lib/get-bus-route-choices"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("free exits explore other edges while declared exits retain their heading", () => {
  for (const constrained of [false, true]) {
    const { input, options } = createTwoViaWindows()
    input.obstacles = input.obstacles.filter(
      (obstacle) => obstacle.componentId === "U1",
    )
    options.escapeLayers = ["top"]
    options.buses = options.buses!.map((bus) =>
      bus.busId === "signal"
        ? {
            ...bus,
            direction: constrained ? "left" : undefined,
            preferredExit: undefined,
            allowedLayers: ["top"],
          }
        : bus,
    )
    const solver = new FanoutSolver(input, options)
    const bus = solver.preparedBuses.find((bus) => bus.busId === "signal")!
    const candidates = getBusRouteChoices(
      {
        ...solver.config,
        srj: input,
        bus,
        targetLayer: "top",
        acceptedPlans: [],
      },
      solver.config.maxLayerCombinations,
    ).flat()
    const headings = new Set(candidates.map((plan) => plan.direction))
    if (constrained) {
      expect(headings).toEqual(new Set(["left"]))
    } else {
      expect(headings.has("up")).toBe(true)
      expect(headings.has("right")).toBe(true)
    }
    expect(candidates.every((plan) => plan.targetLayer === "top")).toBe(true)
  }
})
