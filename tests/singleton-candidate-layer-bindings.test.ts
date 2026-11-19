import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { getSingletonRouteCandidates } from "lib/get-singleton-route-candidates"
import { createCompetingSingletonViaWindows } from "./fixtures/competing-singleton-via-windows"

test("candidate layers preserve explicit exit bindings", (): void => {
  for (const bound of [false, true]) {
    const { input, options } = createCompetingSingletonViaWindows()
    options.escapeLayers = ["top", "bottom"]
    options.buses = options.buses!.map((bus) =>
      bus.busId === "signal"
        ? {
            ...bus,
            allowedLayers: ["top", "bottom"],
            ...(bound
              ? {
                  connectionExitTargets: {
                    DQ: { x: input.bounds.minX, y: 0, layer: "bottom" },
                  },
                }
              : {}),
          }
        : bus,
    )
    const solver = new FanoutSolver(input, options)
    const bus = solver.preparedBuses.find((bus) => bus.busId === "signal")!
    const candidates = getSingletonRouteCandidates({
      ...solver.config,
      srj: input,
      bus,
      targetLayer: "bottom",
      acceptedPlans: [],
    })
    expect(new Set(candidates.map((plan) => plan.targetLayer))).toEqual(
      new Set(bound ? ["bottom"] : ["top", "bottom"]),
    )
    if (!bound) {
      solver.solve()
      expect(solver.solved).toBe(true)
      expect(solver.getOutput().busLayerAssignments.signal).toBe("top")
    }
  }
})
