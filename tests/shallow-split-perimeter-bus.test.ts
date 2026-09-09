import { expect, test } from "bun:test"
import type { SimplifiedPcbTrace } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { FanoutSolver } from "lib/fanout-solver"
import { routeShallowSplitPerimeterBusSteps } from "lib/route-shallow-split-perimeter-bus"
import { routeSplitPerimeterSourceEscapesSteps } from "lib/route-split-perimeter-source-escapes"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import captured from "./fixtures/rk3308-left-top-offset.json"

test("shortens a lower perimeter while preserving all pending source escapes", async () => {
  const fixture = captured as unknown as {
    simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
    solverOptions: ConstructorParameters<typeof FanoutSolver>[1]
  }
  const solver = new FanoutSolver(
    structuredClone(fixture.simpleRouteJson),
    structuredClone(fixture.solverOptions),
  )
  const { routingSrj } = solver as unknown as {
    routingSrj: typeof fixture.simpleRouteJson
  }
  const bus = solver.preparedBuses.find(
    (owner) => owner.busId === "DDR_ADDR_CTRL",
  )!
  const params = {
    ...solver.config,
    srj: routingSrj,
    bus,
    buses: solver.preparedBuses,
    targetLayer: bus.allowedLayers![0]!,
  }
  const sourceSteps = routeSplitPerimeterSourceEscapesSteps(params)
  let sourceStep = sourceSteps.next()
  while (!sourceStep.done) sourceStep = sourceSteps.next()
  const sources = sourceStep.value
  expect(sources?.sourceEscapes).toHaveLength(162)
  if (!sources) throw new Error("Expected complete original source assignments")
  const originalSources = structuredClone(sources)
  const steps = routeShallowSplitPerimeterBusSteps({ ...params, ...sources })
  let step = steps.next()
  while (!step.done) step = steps.next()
  const result = step.value
  expect(result?.plans).toHaveLength(24)
  if (!result) throw new Error("Expected a complete shortened address bus")
  expect(sources).toEqual(originalSources)
  expect(result.sourceEscapes).toHaveLength(162)
  expect(result.sourceBoundary).toEqual(sources.sourceBoundary)
  expect(
    Math.max(...result.plans.map((plan) => plan.length)) -
      Math.min(...result.plans.map((plan) => plan.length)),
  ).toBeLessThanOrEqual(bus.maxLengthSkew!)
  for (const plan of result.plans) {
    const connection = bus.connections.find(
      (connection) => connection.connectionIndex === plan.connectionIndex,
    )!
    expect(plan.sourceObstacle).toBe(connection.sourceObstacle)
    expect(plan.targetPoint).toEqual(connection.targetPoint)
    expect(plan.targetLayer).toBe("inner6")
    expect(plan.exitEdge).toBe("left")
    expect(plan.exitPoint.x).toBe(bus.sharedBoundary.minX)
  }
  const names = new Set(result.plans.map((plan) => plan.connectionName))
  const output = buildOutputSimpleRouteJson({
    inputSrj: routingSrj,
    plans: result.plans,
    layerNames: solver.config.layerNames,
  })
  const addressValidation = validateFanoutSolution({
    inputSrj: routingSrj,
    outputSrj: output,
    plans: result.plans,
    preparedBuses: [bus],
    sharedBoundary: bus.sharedBoundary,
    clearance: solver.config.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(addressValidation.brokenOutConnectionCount).toBe(24)
  // This focused stage intentionally leaves the other buses at their first via.
  expect(
    addressValidation.issues.filter((issue) => issue.code === "missing-plan"),
  ).toHaveLength(138)
  expect(
    addressValidation.issues.filter(
      (issue) => issue.code === "invalid-differential-pair",
    ),
  ).toHaveLength(3)
  expect(new Set(addressValidation.issues.map((issue) => issue.code))).toEqual(
    new Set(["missing-plan", "invalid-differential-pair"]),
  )
  const pendingTraces: SimplifiedPcbTrace[] = result.sourceEscapes
    .filter((source) => !names.has(source.connectionName))
    .map((source) => ({
      type: "pcb_trace",
      pcb_trace_id: `pending-${source.connectionIndex}`,
      connection_name: source.connectionName,
      route: [
        {
          route_type: "wire",
          ...source.segments[0]!.start,
          width: solver.config.traceWidth,
          layer: source.segments[0]!.layer,
        },
        ...source.segments.map((segment) => ({
          route_type: "wire" as const,
          ...segment.end,
          width: segment.width,
          layer: segment.layer,
        })),
        {
          route_type: "via",
          ...source.via.center,
          from_layer: source.via.fromLayer,
          to_layer: source.via.toLayer,
          via_diameter: source.via.diameter,
          hole_diameter: source.via.holeDiameter,
        },
        {
          route_type: "wire",
          ...source.via.center,
          width: solver.config.traceWidth,
          layer: source.via.toLayer,
        },
      ],
    }))
  const routed = {
    ...routingSrj,
    traces: [...result.plans.map((plan) => plan.trace), ...pendingTraces],
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: routingSrj,
      routedSrj: routed,
      clearance: solver.config.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 162,
    checkedViaCount: 162,
    issues: [],
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routed, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 60_000)
