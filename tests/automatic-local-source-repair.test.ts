import { getViaPadConflicts } from "./helpers/get-via-pad-conflicts"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { routeLocalAutomaticSourcesSteps } from "lib/route-local-automatic-sources"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { cropGraphicsToBounds } from "./helpers/crop-fanout-region"
import type { FanoutRoutePlan, FanoutSolverOptions } from "lib/types"

// Native board-world mm (+X right,+Y up), including unchanged prior-phase copper.
test("recovers the final RAM escape while keeping prior-phase copper hard", async () => {
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
    selectedBusIds: string[]
  }
  expect(fixture.srj.traces).toHaveLength(91)
  const original = JSON.stringify(fixture),
    solver = new FanoutSolver(fixture.srj, fixture.options)
  const connections = solver.preparedBuses.flatMap((bus) => bus.connections)
  const plans = fixture.plans.map((plan) => ({
    ...plan,
    sourceObstacle: connections.find(
      (connection) => connection.connectionIndex === plan.connectionIndex,
    )!.sourceObstacle,
  }))
  const buses = fixture.selectedBusIds.map(
    (id) => solver.preparedBuses.find((bus) => bus.busId === id)!,
  )
  const routingSrj = Reflect.get(solver, "routingSrj") as SimpleRouteJson
  const params = { ...solver.config, srj: routingSrj, buses, plans }
  const run = (srj: SimpleRouteJson) => {
    const steps = routeLocalAutomaticSourcesSteps({ ...params, srj })
    let next = steps.next()
    while (!next.done) next = steps.next()
    return next.value
  }
  const recovered = run(routingSrj)
  expect(recovered).toHaveLength(91)
  const normalized = normalizeFanoutPlanCorners({
    ...solver.config,
    inputSrj: fixture.srj,
    preparedBuses: solver.preparedBuses,
    plans: recovered!,
    repairSignalSourceCorners: true,
    repairPlaneSourceCorners: true,
  })
  expect(normalized).toHaveLength(91)
  const output = buildOutputSimpleRouteJson({
    inputSrj: fixture.srj,
    plans: normalized!,
    layerNames: solver.config.layerNames,
  })
  expect(
    validateFanoutSolution({
      ...solver.config,
      inputSrj: fixture.srj,
      outputSrj: output,
      plans: normalized!,
      preparedBuses: solver.preparedBuses,
      sharedBoundary: fixture.options.sharedBoundary!,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 91,
    brokenOutConnectionCount: 91,
    issues: [],
  })
  const physical = getViaPadConflicts(
    fixture.srj,
    normalized!,
    solver.config.clearance,
  )
  expect(physical).toEqual([])
  // A foreign supplied trace through the missing source must still block it.
  const source = buses[0]!.connections[0]!.sourcePoint
  const blocked = {
    ...routingSrj,
    traces: [
      ...(routingSrj.traces ?? []),
      {
        type: "pcb_trace" as const,
        pcb_trace_id: "foreign-prior-phase",
        connection_name: "foreign-prior-phase",
        route: [-0.3, 0.3].map((dx) => ({
          route_type: "wire" as const,
          x: source.x + dx,
          y: source.y,
          layer: "top",
          width: solver.config.traceWidth,
        })),
      },
    ],
  }
  expect(run(blocked)).toBeNull()
  expect(JSON.stringify(fixture)).toBe(original)
  await expect(
    getSvgFromGraphicsObject(
      cropGraphicsToBounds(
        visualizeSimpleRouteJson({ ...output, connections: [] }),
        fixture.options.sharedBoundary!,
      ),
      { backgroundColor: "white", svgWidth: 1100, svgHeight: 750 },
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
