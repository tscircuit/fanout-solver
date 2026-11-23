import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { getCachedFanoutPlanClearanceValidator } from "lib/route-bus/plan-clearance"
import { planIsStaticallyClear } from "lib/route-bus/plan-static-clearance"
import type { FanoutRoutePlan, FanoutSolverOptions } from "lib/types"

test("cached spatial clearance preserves full-scan decisions and isolates policies", () => {
  const fixture = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/butterstick-second-field-local-repair.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  ) as {
    srj: SimpleRouteJson
    options: FanoutSolverOptions
    plans: FanoutRoutePlan[]
  }
  const solver = new FanoutSolver(fixture.srj, fixture.options)
  const srj = Reflect.get(solver, "routingSrj") as SimpleRouteJson
  const connections = solver.preparedBuses.flatMap((b) => b.connections)
  const plans = fixture.plans.map((p) => ({
    ...p,
    sourceObstacle: connections.find(
      (c) => c.connectionIndex === p.connectionIndex,
    )!.sourceObstacle,
  }))
  const foreign = srj.obstacles.find(
    (o) =>
      o.layers.includes("top") &&
      o.width > 0 &&
      !o.connectedTo.includes(plans[0]!.connectionName),
  )!
  const badWire = {
    ...plans[0]!,
    segments: [
      {
        start: { x: foreign.center.x - foreign.width, y: foreign.center.y },
        end: { x: foreign.center.x + foreign.width, y: foreign.center.y },
        width: solver.config.traceWidth,
        layer: "top",
      },
    ],
    sourceEscapeSegmentCount: 0,
  }
  const badVia = {
    ...plans[0]!,
    via: {
      center: foreign.center,
      diameter: solver.config.viaDiameter,
      holeDiameter: solver.config.viaHoleDiameter,
      fromLayer: "top",
      toLayer: "bottom",
      spanLayers: solver.config.layerNames,
    },
  }
  const candidates = [...plans, badWire, badVia]
  for (const allowSameNetMerges of [false, true])
    for (const allowBlindAndBuriedVias of [false, true])
      for (const clearance of [
        solver.config.clearance,
        solver.config.clearance + 0.05,
      ]) {
        const params = {
          ...solver.config,
          srj,
          sharedBoundary: fixture.options.sharedBoundary!,
          allowSameNetMerges,
          allowBlindAndBuriedVias,
          clearance,
        }
        const cached = getCachedFanoutPlanClearanceValidator(params)
        expect(candidates.map((plan) => cached.staticallyClear(plan))).toEqual(
          candidates.map((plan) => planIsStaticallyClear({ ...params, plan })),
        )
      }
  const params = {
    ...solver.config,
    srj,
    sharedBoundary: fixture.options.sharedBoundary!,
  }
  expect(
    getCachedFanoutPlanClearanceValidator(params).staticallyClear(badWire),
  ).toBe(false)
  expect(
    getCachedFanoutPlanClearanceValidator(params).staticallyClear(badVia),
  ).toBe(false)
  // A new routing phase's obstacle cannot inherit the earlier SRJ's result.
  const plan = plans.find((plan) => planIsStaticallyClear({ ...params, plan }))!
  const segment = plan.segments.at(-1)!
  const changed = {
    ...srj,
    obstacles: [
      ...srj.obstacles,
      {
        type: "rect" as const,
        center: {
          x: (segment.start.x + segment.end.x) / 2,
          y: (segment.start.y + segment.end.y) / 2,
        },
        width: 0.01,
        height: 0.01,
        layers: [segment.layer],
        connectedTo: ["foreign-new-phase"],
      },
    ],
  }
  expect(
    getCachedFanoutPlanClearanceValidator({
      ...params,
      srj: changed,
    }).staticallyClear(plan),
  ).toBe(false)
})
