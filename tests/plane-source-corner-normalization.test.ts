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

test("normalizes plane source corners without moving pads, physical vias, or neighboring copper", async () => {
  const bounds = { minX: -1, maxX: 3, minY: -1, maxY: 1.5 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const sources = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
  ]
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((source, i) => ({
      name: `P${i}`,
      pointsToConnect: [
        { ...source, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
      ],
    })),
    obstacles: sources.flatMap((source, i) => [
      {
        type: "rect" as const,
        shape: "circle",
        center: source,
        width: 0.254,
        height: 0.254,
        layers: ["top"],
        componentId: `U${i}`,
        obstacleId: `P${i}`,
        connectedTo: [`P${i}`],
      },
      ...[
        { x: source.x, y: -0.5 },
        { x: source.x - 0.5, y: 0 },
        { x: source.x, y: 0.5 },
      ].map((center, j) => ({
        type: "rect" as const,
        shape: "circle",
        center,
        width: 0.254,
        height: 0.254,
        layers: ["top"],
        componentId: `U${i}`,
        obstacleId: `block${i}-${j}`,
        connectedTo: [],
      })),
    ]),
  }
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: sources.map((_, i) => ({
      busId: `plane${i}`,
      sourceComponentId: `U${i}`,
      connectionNames: [`P${i}`],
      direction: "up",
      termination: { type: "plane", layer: "inner1" },
    })),
  })
  const paths = [
    [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.25 },
      { x: -0.15, y: 0.25 },
      { x: -0.25, y: 0.35 },
      { x: -0.25, y: 0.75 },
    ],
    [
      { x: 2, y: 0 },
      { x: 2.32928, y: 0.25 },
      { x: 2.72928, y: 0.25 },
    ],
  ]
  const plans = preparedBuses.map((bus, i) =>
    buildViaMinimalWindingPlan({
      ...rules,
      layerNames,
      bus,
      terminal: {
        connection: bus.connections[0]!,
        viaPoint: paths[i]!.at(-1)!,
        exitPoint: paths[i]!.at(-1)!,
      },
      targetLayer: "inner1",
      targetLayerPoints: [paths[i]!.at(-1)!],
      sourceEscapePoints: paths[i]!,
      allowBlindAndBuriedVias: false,
    }),
  )
  const before = JSON.stringify({ inputSrj, preparedBuses, plans })
  const normalized = normalizeFanoutPlanCorners({
    ...rules,
    inputSrj,
    preparedBuses,
    plans,
    layerNames,
    repairPlaneSourceCorners: true,
  })
  expect(normalized).not.toBeNull()
  expect(JSON.stringify({ inputSrj, preparedBuses, plans })).toBe(before)
  expect(
    normalizeFanoutPlanCorners({
      ...rules,
      inputSrj,
      preparedBuses,
      plans,
      layerNames,
    }),
  ).toBeNull()
  for (let i = 0; i < plans.length; i++) {
    expect(normalized![i]!.via).toBe(plans[i]!.via)
    expect(normalized![i]!.exitPoint).toBe(plans[i]!.exitPoint)
    expect(normalized![i]!.trace.route[0]).toBe(plans[i]!.trace.route[0])
    const route = normalized![i]!.segments
    for (let j = 0; j < route.length; j++) {
      const a = route[j]!,
        b = route[j + 1],
        dx = a.end.x - a.start.x,
        dy = a.end.y - a.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      if (b?.layer === a.layer) {
        const nx = b.end.x - b.start.x,
          ny = b.end.y - b.start.y
        expect(
          (dx * nx + dy * ny) / Math.hypot(dx, dy) / Math.hypot(nx, ny),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
      }
    }
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: normalized!,
    layerNames,
  })
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
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 2, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: normalized!.map((p) => p.trace) },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })
  // Source-only repairs never enter target-path tuning, but their final copper
  // must still satisfy every declared pair that is present in this plan set.
  const pairedInput: SimpleRouteJson = {
    ...inputSrj,
    differentialPairs: [
      { connectionNames: ["P0", "P1"], lengthTolerance: 0.25 },
    ],
  }
  const pairParams = {
    ...rules,
    inputSrj: pairedInput,
    preparedBuses,
    plans,
    layerNames,
    repairPlaneSourceCorners: true,
  }
  expect(
    Math.abs(normalized![0]!.length - normalized![1]!.length),
  ).toBeGreaterThan(0.25)
  expect(normalizeFanoutPlanCorners(pairParams)).toBeNull()
  expect(
    normalizeFanoutPlanCorners({
      ...pairParams,
      inputSrj: {
        ...pairedInput,
        differentialPairs: [
          { connectionNames: ["P0", "P1"], lengthTolerance: 0.5 },
        ],
      },
    }),
  ).toEqual(normalized)
  // Partial-bus callers may normalize one member before the other is routed.
  expect(
    normalizeFanoutPlanCorners({
      ...pairParams,
      preparedBuses: [preparedBuses[0]!],
      plans: [plans[0]!],
    }),
  ).toEqual([normalized![0]!])
  expect(JSON.stringify({ inputSrj, preparedBuses, plans })).toBe(before)
  // A separate endpoint leg is a different copper partition. Source-only
  // repair must reject it instead of reclassifying any of that copper.
  const endpointStart = { x: 0.75, y: -0.75 }
  const endpointEnd = { x: 1.25, y: -0.75 }
  const endpointPlan = {
    ...plans[0]!,
    length: plans[0]!.length + 0.5,
    planeEndpointSegments: [
      {
        start: endpointStart,
        end: endpointEnd,
        width: rules.traceWidth,
        layer: "top",
      },
    ],
    planeEndpointVia: {
      center: endpointStart,
      diameter: rules.viaDiameter,
      holeDiameter: rules.viaHoleDiameter,
      fromLayer: "inner1",
      toLayer: "top",
      spanLayers: layerNames,
    },
    planeEndpointTrace: {
      type: "pcb_trace" as const,
      pcb_trace_id: "separate-plane-endpoint",
      connection_name: plans[0]!.connectionName,
      route: [
        {
          route_type: "wire" as const,
          ...endpointStart,
          layer: "inner1",
          width: rules.traceWidth,
        },
        {
          route_type: "via" as const,
          ...endpointStart,
          from_layer: "inner1",
          to_layer: "top",
          via_diameter: rules.viaDiameter,
          via_hole_diameter: rules.viaHoleDiameter,
        },
        {
          route_type: "wire" as const,
          ...endpointStart,
          layer: "top",
          width: rules.traceWidth,
        },
        {
          route_type: "wire" as const,
          ...endpointEnd,
          layer: "top",
          width: rules.traceWidth,
        },
      ],
    },
  }
  const separateEndpointPlans = [endpointPlan, plans[1]!]
  const endpointBefore = JSON.stringify(separateEndpointPlans)
  expect(
    normalizeFanoutPlanCorners({
      ...rules,
      inputSrj,
      preparedBuses,
      plans: separateEndpointPlans,
      layerNames,
      repairPlaneSourceCorners: true,
    }),
  ).toBeNull()
  expect(JSON.stringify(separateEndpointPlans)).toBe(endpointBefore)
  const blockedInput = {
    ...inputSrj,
    obstacles: [
      ...inputSrj.obstacles,
      {
        type: "rect" as const,
        center: { x: 0.24, y: 0.24 },
        width: 0.1,
        height: 0.1,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
  expect(
    normalizeFanoutPlanCorners({
      ...rules,
      inputSrj: blockedInput,
      preparedBuses,
      plans,
      layerNames,
      repairPlaneSourceCorners: true,
    }),
  ).toBeNull()
  const graphics = visualizeSimpleRouteJson({ ...outputSrj, connections: [] })
  graphics.lines ??= []
  for (const line of graphics.lines) line.strokeColor = "#2563eb"
  graphics.texts ??= []
  for (const p of plans)
    for (const s of p.segments)
      graphics.lines.push({
        points: [s.start, s.end],
        strokeColor: "#ef4444",
        strokeWidth: 0.012,
      })
  graphics.texts.push({
    x: 0.5,
    y: 1.15,
    text: "Original centerline in red; repaired copper in blue",
    fontSize: 0.14,
    anchorSide: "bottom_left",
  })
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
