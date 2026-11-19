import { expect, test } from "bun:test"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type { BusRouteRepairContext } from "lib/bus-route-repair-context"
import { FanoutSolver } from "lib/fanout-solver"
import { getBusRouteChoices } from "lib/get-bus-route-choices"
import { repairBusRouteComponent } from "lib/repair-bus-route-component"
import { createFanoutPlanClearanceValidator, routeBus } from "lib/route-bus"
import { busUsesCoordinatedWindingChannel } from "lib/route-bus/directions"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createCompetingSingletonViaWindows } from "./fixtures/competing-singleton-via-windows"

test("ordinary repair leaves accepted coordinated copper fixed", () => {
  const { input, options } = createCompetingSingletonViaWindows()
  options.buses = options.buses!.map((bus) =>
    bus.busId === "signal"
      ? {
          ...bus,
          exitEdge: "left" as const,
          connectionExitTargets: {
            DQ: { x: input.bounds.minX, y: 0, layer: "bottom" },
          },
        }
      : bus,
  )
  const solver = new FanoutSolver(input, options)
  const ground = solver.preparedBuses.find((bus) => bus.busId === "ground")!
  const signal = solver.preparedBuses.find((bus) => bus.busId === "signal")!
  expect(busUsesCoordinatedWindingChannel(signal)).toBe(true)
  const route = { ...solver.config, srj: input }
  const planeRoute = {
    ...route,
    bus: ground,
    targetLayer: "inner1",
    acceptedPlans: [],
  }
  const signalRoute = {
    ...route,
    bus: signal,
    targetLayer: "bottom",
    acceptedPlans: [],
  }
  const original = routeBus(signalRoute)!
  const addition = routeBus(planeRoute)!
  const originalCopper = JSON.stringify(original)
  expect(getBusRouteChoices(signalRoute, 2)).toEqual([])
  expect(getBusRouteChoices(planeRoute, 2).length).toBeGreaterThan(0)
  const context: BusRouteRepairContext = {
    busesById: new Map(solver.preparedBuses.map((bus) => [bus.busId, bus])),
    choicesByBus: new Map(),
    route,
    clearPlans: createFanoutPlanClearanceValidator({
      ...route,
      sharedBoundary: ground.sharedBoundary,
    }),
    maximumChoices: solver.config.maxLayerCombinations,
    remainingSearchStates: solver.config.maxLayerCombinations,
  }
  expect(context.clearPlans.mutuallyClear([...addition, ...original])).toBe(false)
  expect(
    repairBusRouteComponent(
      { addition, acceptedByBus: new Map([[signal.busId, original]]) },
      context,
    ),
  ).toBeUndefined()
  expect(JSON.stringify(original)).toBe(originalCopper)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: buildOutputSimpleRouteJson({
        inputSrj: input,
        plans: original,
        layerNames: solver.config.layerNames,
      }),
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 1, issues: [] })
})
