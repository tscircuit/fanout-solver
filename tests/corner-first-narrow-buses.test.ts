import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { routeReservedSourceBusesSteps } from "lib/route-reserved-source-buses"
import { routeShallowSplitPerimeterBusSteps } from "lib/route-shallow-split-perimeter-bus"
import { routeSplitPerimeterSourceEscapesSteps } from "lib/route-split-perimeter-source-escapes"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import captured from "./fixtures/rk3308-left-top-offset.json"

test("routes corner-guided narrow buses before sweeping the center sources", async () => {
  const fixture = captured as unknown as {
    simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
    solverOptions: ConstructorParameters<typeof FanoutSolver>[1]
  }
  const solver = new FanoutSolver(
    structuredClone(fixture.simpleRouteJson),
    structuredClone(fixture.solverOptions),
  )
  while (!solver.layerAssignments.length) solver.step()
  const { routingSrj } = solver as unknown as {
    routingSrj: typeof fixture.simpleRouteJson
  }
  const bus = solver.preparedBuses.find(
    (owner) => owner.busId === "DDR_ADDR_CTRL",
  )!
  const targetLayerByBusId = new Map(
    Object.entries(solver.layerAssignments[0]!),
  )
  const params = {
    ...solver.config,
    srj: routingSrj,
    bus,
    buses: solver.preparedBuses,
    targetLayer: targetLayerByBusId.get(bus.busId)!,
    targetLayerByBusId,
  }
  const sourceSteps = routeSplitPerimeterSourceEscapesSteps(params)
  let sourceStep = sourceSteps.next()
  while (!sourceStep.done) sourceStep = sourceSteps.next()
  if (!sourceStep.value)
    throw new Error("Expected a complete source assignment")
  const addressSteps = routeShallowSplitPerimeterBusSteps({
    ...params,
    ...sourceStep.value,
  })
  let addressStep = addressSteps.next()
  while (!addressStep.done) addressStep = addressSteps.next()
  if (!addressStep.value) throw new Error("Expected a complete address bus")
  const { plans: initialPlans, ...sources } = addressStep.value
  const buses = solver.preparedBuses.filter(
    (owner) =>
      owner.termination.type === "boundary" &&
      (owner.connections.length > 2 ||
        targetLayerByBusId.get(owner.busId) === "inner5"),
  )
  const steps = routeReservedSourceBusesSteps({
    ...params,
    ...sources,
    buses,
    initialPlans,
  })
  let step = steps.next()
  while (!step.done) step = steps.next()
  const plans = step.value
  expect(plans).toHaveLength(48)
  if (!plans)
    throw new Error("Expected complete address, byte, and inner5 buses")
  const narrow = plans.filter((plan) => plan.targetLayer === "inner5")
  expect(narrow).toHaveLength(8)
  for (const plan of narrow) {
    const owner = buses.find((bus) => bus.busId === plan.busId)!
    const connection = owner.connections.find(
      (connection) => connection.connectionIndex === plan.connectionIndex,
    )!
    expect(plan.sourceObstacle).toBe(connection.sourceObstacle)
    expect(plan.targetPoint).toEqual(connection.targetPoint)
    expect(plan.exitEdge).toBe("left")
    expect(plan.exitPoint.x).toBe(owner.sharedBoundary.minX)
    if (owner.preferredExit === "top-left")
      expect(plan.cornerBandSide).toBe("maximum")
    else expect(plan.cornerBandSide).toBeUndefined()
  }
  const routed = { ...routingSrj, traces: plans.map((plan) => plan.trace) }
  expect(
    validateRoutedCopperDrc({
      inputSrj: routingSrj,
      routedSrj: routed,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 48,
    checkedViaCount: 80,
    issues: [],
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routed, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
