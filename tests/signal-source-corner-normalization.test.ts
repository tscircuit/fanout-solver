import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("normalizes a rectangular BGA dogbone while retaining its target and prior-phase copper", async () => {
  const bounds = { minX: -1, maxX: 2, minY: -1.5, maxY: 1.5 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const source = { x: 0, y: 0 }
  const viaPoint = { x: 0.325, y: 0.4 }
  const exitPoint = { x: 2, y: 0.4 }
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { ...source, layer: "top", pcb_port_id: "P1" },
          { ...exitPoint, layer: "inner1" },
        ],
      },
    ],
    obstacles: [
      source,
      { x: 0.65, y: 0 },
      { x: 0, y: 0.8 },
      { x: 0.65, y: 0.8 },
    ].map((center, i) => ({
      type: "rect",
      shape: "circle",
      center,
      width: 0.32,
      height: 0.32,
      layers: ["top"],
      componentId: "U1",
      obstacleId: `P${i + 1}`,
      connectedTo: i === 0 ? ["signal", "P1"] : [],
    })),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "previous-phase",
        connection_name: "previous-phase-connection",
        route: [
          {
            route_type: "wire",
            x: -0.5,
            y: -1,
            layer: "inner1",
            width: rules.traceWidth,
          },
          {
            route_type: "wire",
            x: 1.5,
            y: -1,
            layer: "inner1",
            width: rules.traceWidth,
          },
        ],
      },
    ],
  }
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "signal-bus",
        sourceComponentId: "U1",
        connectionNames: ["signal"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["inner1"],
      },
    ],
  })
  const bus = preparedBuses[0]!
  bus.exitEdge = "right"
  const plan = buildViaMinimalWindingPlan({
    ...rules,
    layerNames,
    bus,
    terminal: { connection: bus.connections[0]!, viaPoint, exitPoint },
    targetLayer: "inner1",
    targetLayerPoints: [viaPoint, exitPoint],
    sourceEscapePoints: [source, viaPoint],
    allowBlindAndBuriedVias: false,
  })
  const params = {
    ...rules,
    inputSrj,
    preparedBuses,
    plans: [plan],
    layerNames,
  }
  const before = JSON.stringify(params)
  expect(normalizeFanoutPlanCorners(params)).toBeNull()
  const normalized = normalizeFanoutPlanCorners({
    ...params,
    repairSignalSourceCorners: true,
  })
  expect(normalized).not.toBeNull()
  expect(JSON.stringify(params)).toBe(before)
  const result = normalized![0]!
  expect(result.via).toBe(plan.via)
  expect(result.additionalVias).toBe(plan.additionalVias)
  expect(result.exitPoint).toBe(plan.exitPoint)
  expect(result.sourcePoint).toBe(plan.sourcePoint)
  expect(result.sourceEscapeSegmentCount).toBeGreaterThan(1)
  const oldVia = plan.trace.route.findIndex((p) => p.route_type === "via")
  const newVia = result.trace.route.findIndex((p) => p.route_type === "via")
  expect(result.trace.route.slice(newVia)).toEqual(
    plan.trace.route.slice(oldVia),
  )
  expect(result.segments.slice(result.sourceEscapeSegmentCount)).toEqual(
    plan.segments.slice(1),
  )
  for (const [index, segment] of result.segments.entries()) {
    const dx = segment.end.x - segment.start.x
    const dy = segment.end.y - segment.start.y
    expect(
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ),
    ).toBeLessThan(1e-7)
    const next = result.segments[index + 1]
    if (next?.layer !== segment.layer) continue
    const nx = next.end.x - next.start.x
    const ny = next.end.y - next.start.y
    expect(
      (dx * nx + dy * ny) / Math.hypot(dx, dy) / Math.hypot(nx, ny),
    ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: normalized!,
    layerNames,
  })
  expect(outputSrj.traces).toContainEqual(inputSrj.traces![0]!)
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans: normalized!,
      preparedBuses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 1, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: [result.trace] },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 1,
    checkedViaCount: 1,
    issues: [],
  })
  // An unknown previous-phase owner is still hard copper on the target layer.
  const blockedInput: SimpleRouteJson = {
    ...inputSrj,
    traces: [
      {
        ...inputSrj.traces![0]!,
        route: [
          {
            route_type: "wire",
            x: 1,
            y: 0,
            layer: "inner1",
            width: rules.traceWidth,
          },
          {
            route_type: "wire",
            x: 1,
            y: 0.8,
            layer: "inner1",
            width: rules.traceWidth,
          },
        ],
      },
    ],
  }
  expect(
    normalizeFanoutPlanCorners({
      ...params,
      inputSrj: blockedInput,
      repairSignalSourceCorners: true,
    }),
  ).toBeNull()
  const graphics = visualizeSimpleRouteJson({ ...outputSrj, connections: [] })
  graphics.lines ??= []
  graphics.lines.push({
    points: [source, viaPoint],
    strokeColor: "#ef4444",
    strokeWidth: 0.012,
  })
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
