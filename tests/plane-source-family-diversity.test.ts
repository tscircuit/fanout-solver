import { expect, test } from "bun:test"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { FanoutSolver } from "lib/fanout-solver"
import { distance, pointIsInsideObstacle } from "lib/geometry"
import { routeBus, routeBusAlternatives } from "lib/route-bus"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import type { FanoutRoutePlan } from "lib/types"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

function getLeadHeading(plan: FanoutRoutePlan): number {
  const lead = plan.segments.find(
    (segment) =>
      segment.layer === plan.sourceLayer &&
      !pointIsInsideObstacle(segment.end, plan.sourceObstacle),
  )!
  return Math.round(
    Math.atan2(lead.end.y - lead.start.y, lead.end.x - lead.start.x) / (Math.PI / 4),
  )
}

test("nearby geometry alternatives survive neighboring plane sites", () => {
  const { input, options } = createTwoViaWindows()
  const solver = new FanoutSolver(input, options)
  const ground = solver.preparedBuses.find((bus) => bus.busId === "ground")!
  const route = {
    ...solver.config,
    srj: input,
    bus: ground,
    targetLayer: "inner1",
    acceptedPlans: [],
  }
  const alternatives = routeBusAlternatives(route, 3)
  expect(alternatives).toHaveLength(3)
  expect(alternatives[0]![0]!.trace.route).toEqual(routeBus(route)![0]!.trace.route)
  const neighbor = { x: -0.24, y: 0.3 }
  const sites = alternatives.map(([plan]) => plan!.via!.center)
  expect(sites).toContainEqual(neighbor)
  const neighborHeadings = alternatives
    .flat()
    .filter((plan) => distance(plan.via!.center, neighbor) < 1e-9)
    .map(getLeadHeading)
  expect(
    alternatives.flat().some((plan) => {
      const separation = distance(plan.via!.center, neighbor)
      return (
        separation > 1e-9 &&
        separation < solver.config.viaDiameter / 2 &&
        neighborHeadings.includes(getLeadHeading(plan))
      )
    }),
  ).toBe(true)
  for (const plans of alternatives) {
    expect(
      validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: buildOutputSimpleRouteJson({
          inputSrj: input,
          plans,
          layerNames: solver.config.layerNames,
        }),
        clearance: solver.config.clearance,
        allowBlindAndBuriedVias: false,
      }).valid,
    ).toBe(true)
  }
})
