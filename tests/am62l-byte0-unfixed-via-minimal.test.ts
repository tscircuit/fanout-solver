import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutPlansAreClear, routeBusAlternatives } from "lib/route-bus"
import type { FanoutSolverOptions } from "lib/types"
import capturedFixture from "./fixtures/am62l-lpddr4-three-bus-through-all.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

test("tries legal BYTE0 target interleaves before crossover vias", () => {
  const solver = new FanoutSolver(
    structuredClone(fixture.inputSrj),
    structuredClone(fixture.options),
  )
  const bus = solver.preparedBuses.find(
    (candidate) => candidate.busId === "DDR_BYTE0",
  )
  expect(bus).toBeDefined()
  if (!bus) throw new Error("DDR_BYTE0 was not prepared")

  const plans = routeBusAlternatives(
    {
      srj: fixture.inputSrj,
      bus,
      targetLayer: "inner4",
      acceptedPlans: [],
      layerNames: solver.config.layerNames,
      traceWidth: solver.config.traceWidth,
      viaDiameter: solver.config.viaDiameter,
      viaHoleDiameter: solver.config.viaHoleDiameter,
      clearance: solver.config.clearance,
      compactBusTracks: solver.config.compactBusTracks,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: solver.config.allowSameNetMerges,
    },
    1,
  )[0]

  expect(plans).toHaveLength(bus.connections.length)
  expect(
    plans?.every(
      (plan) =>
        (plan.additionalVias ?? []).length === 0 &&
        plan.trace.route.filter((point) => point.route_type === "via")
          .length === 1,
    ),
  ).toBe(true)
  expect(
    plans &&
      fanoutPlansAreClear({
        plans,
        srj: fixture.inputSrj,
        sharedBoundary: bus.sharedBoundary,
        clearance: solver.config.clearance,
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: solver.config.allowSameNetMerges,
      }),
  ).toBe(true)
}, 10_000)
