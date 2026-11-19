import { expect, test } from "bun:test"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type { BusRouteRepairContext } from "lib/bus-route-repair-context"
import { FanoutSolver } from "lib/fanout-solver"
import { repairBusRouteComponent } from "lib/repair-bus-route-component"
import { createFanoutPlanClearanceValidator, routeBus } from "lib/route-bus"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createCompetingSingletonViaWindows } from "./fixtures/competing-singleton-via-windows"

test("a small repair budget still considers routes clear of the new plane via", () => {
  const { input, options } = createCompetingSingletonViaWindows()
  const solver = new FanoutSolver(input, { ...options, maxLayerCombinations: 2 })
  const ground = solver.preparedBuses.find((bus) => bus.busId === "ground")!
  const signal = solver.preparedBuses.find((bus) => bus.busId === "signal")!
  const route = { ...solver.config, srj: input }
  const addition = routeBus({
    ...route,
    bus: ground,
    targetLayer: "inner1",
    acceptedPlans: [],
  })!
  const original = routeBus({
    ...route,
    bus: signal,
    targetLayer: "bottom",
    acceptedPlans: [],
  })!
  const replacement = routeBus({
    ...route,
    bus: signal,
    targetLayer: "bottom",
    acceptedPlans: addition,
  })!
  const context: BusRouteRepairContext = {
    busesById: new Map(solver.preparedBuses.map((bus) => [bus.busId, bus])),
    choicesByBus: new Map([[signal.busId, [original, replacement]]]),
    route,
    clearPlans: createFanoutPlanClearanceValidator({
      ...route,
      sharedBoundary: ground.sharedBoundary,
    }),
    maximumChoices: solver.config.maxLayerCombinations,
    remainingSearchStates: solver.config.maxLayerCombinations,
  }
  expect(context.clearPlans.mutuallyClear([...addition, ...original])).toBe(false)
  const repaired = repairBusRouteComponent(
    {
      addition,
      acceptedByBus: new Map([[signal.busId, original]]),
    },
    context,
  )
  expect(repaired?.map((plan) => plan.busId).sort()).toEqual(["ground", "signal"])
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: buildOutputSimpleRouteJson({
        inputSrj: input,
        plans: repaired ?? [],
        layerNames: solver.config.layerNames,
      }),
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })
})
