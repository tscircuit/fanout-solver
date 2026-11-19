import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { routeBus } from "lib/route-bus"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { createIcepiPlaneDrop } from "./fixtures/icepi-plane-drop"

function reverseTrace(trace: SimplifiedPcbTrace): SimplifiedPcbTrace {
  return {
    ...trace,
    route: trace.route.toReversed().map((point) =>
      point.route_type === "via"
        ? {
            ...point,
            from_layer: point.to_layer,
            to_layer: point.from_layer,
          }
        : point,
    ),
  }
}

test("plane drops retain terminal-layer pour and through-via copper clearance", (): void => {
  const params = createIcepiPlaneDrop()
  const plans = routeBus(params)
  expect(plans).toHaveLength(1)
  const plan = plans?.[0]
  if (!plan?.via) throw new Error("Native plane drop has no through-via")
  const via = plan.via
  const sourceEscapePath = [
    plan.segments[0].start,
    ...plan.segments.map((segment) => segment.end),
  ]
  const fixedParams = {
    ...params,
    fixedViaPointsByConnectionIndex: new Map([
      [plan.connectionIndex, via.center],
    ]),
    sourceEscapePaths: new Map([[plan.connectionIndex, sourceEscapePath]]),
  }
  // Beyond the wire endpoint: inside via clearance, outside trace clearance.
  const blockerCenter = { x: via.center.x + 0.3, y: via.center.y }
  const cases = [
    { layer: "inner1", isCopperPour: true, routeClear: true, drcClear: true },
    { layer: "bottom", isCopperPour: true, routeClear: true, drcClear: true },
    { layer: "top", isCopperPour: true, routeClear: false, drcClear: false },
    { layer: "inner2", isCopperPour: true, routeClear: false, drcClear: false },
    {
      layer: "bottom",
      isCopperPour: false,
      routeClear: false,
      drcClear: false,
    },
  ]
  for (const scenario of cases) {
    const blocker: Obstacle = {
      type: "rect",
      obstacleId: "foreign-via-clearance",
      center: blockerCenter,
      width: 0.04,
      height: 0.04,
      layers: [scenario.layer],
      connectedTo: ["injected-foreign-net"],
      isCopperPour: scenario.isCopperPour,
    }
    const inputSrj = {
      ...params.srj,
      obstacles: [...params.srj.obstacles, blocker],
    }
    expect(routeBus({ ...fixedParams, srj: inputSrj }) !== null).toBe(
      scenario.routeClear,
    )
    for (const trace of [plan.trace, reverseTrace(plan.trace)]) {
      const report = validateRoutedCopperDrc({
        inputSrj,
        routedSrj: { ...inputSrj, traces: [trace] },
        clearance: params.clearance,
        allowBlindAndBuriedVias: false,
      })
      expect(report.valid).toBe(scenario.drcClear)
      if (!scenario.drcClear) {
        expect(report.issues.map((issue) => issue.code)).toEqual([
          "via-obstacle-clearance",
        ])
      }
    }
  }

  const foreignConnection: SimpleRouteConnection = {
    name: "foreign-supplied-trace",
    pointsToConnect: [
      { x: blockerCenter.x, y: blockerCenter.y - 0.1, layer: "bottom" },
      { x: blockerCenter.x, y: blockerCenter.y + 0.1, layer: "bottom" },
    ],
  }
  const foreignTrace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "supplied-bottom-copper",
    connection_name: foreignConnection.name,
    route: foreignConnection.pointsToConnect.map((point) => ({
      route_type: "wire",
      x: point.x,
      y: point.y,
      layer: "bottom",
      width: params.traceWidth,
    })),
  }
  const inputSrj = {
    ...params.srj,
    connections: [...params.srj.connections, foreignConnection],
    traces: [foreignTrace],
  }
  expect(routeBus({ ...fixedParams, srj: inputSrj })).toBeNull()
  const report = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: { ...inputSrj, traces: [foreignTrace, plan.trace] },
    clearance: params.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(report.issues.map((issue) => issue.code)).toEqual([
    "different-net-trace-via-clearance",
  ])
})
