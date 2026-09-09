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

test("final tuning normalization chamfers a sub-grid corner while preserving source copper and exact exits", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.12,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const sources = [
    { x: -0.325, y: -0.325 },
    { x: -0.325, y: -2.125 },
    { x: -2, y: 1 },
  ]
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((source, index) => ({
      name: `N${index}`,
      pointsToConnect: [
        {
          ...source,
          layer: "top",
          pointId: `P${index}`,
          pcb_port_id: `P${index}`,
        },
        ...(index < 2
          ? [{ x: 3, y: 1.38116 - index * 1.8, layer: "inner1" }]
          : []),
      ],
    })),
    obstacles: sources.map((center, index) => ({
      type: "rect",
      center,
      width: 0.18,
      height: 0.18,
      componentId: "U1",
      obstacleId: `P${index}`,
      layers: ["top"],
      connectedTo: [`N${index}`, `P${index}`],
    })),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "supplied",
        connection_name: "N2",
        route: [
          {
            route_type: "wire",
            x: -2.4,
            y: -2.6,
            layer: "top",
            width: rules.traceWidth,
          },
          {
            route_type: "wire",
            x: -2.1,
            y: -2.6,
            layer: "top",
            width: rules.traceWidth,
          },
          {
            route_type: "via",
            x: -2.1,
            y: -2.6,
            from_layer: "top",
            to_layer: "bottom",
            via_diameter: rules.viaDiameter,
            via_hole_diameter: rules.viaHoleDiameter,
          },
          {
            route_type: "wire",
            x: -2.1,
            y: -2.6,
            layer: "bottom",
            width: rules.traceWidth,
          },
          {
            route_type: "wire",
            x: -1.8,
            y: -2.6,
            layer: "bottom",
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
        busId: "clock",
        sourceComponentId: "U1",
        connectionNames: ["N0", "N1"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["inner1"],
        maxLengthSkew: 0.25,
      },
      {
        busId: "plane",
        sourceComponentId: "U1",
        connectionNames: ["N2"],
        direction: "right",
        termination: { type: "plane", layer: "inner2" },
      },
    ],
  })
  for (const bus of preparedBuses)
    if (bus.termination.type === "boundary") bus.exitEdge = "right"
  const plans = preparedBuses.flatMap((bus) =>
    bus.connections.map((connection) => {
      const index = connection.connectionIndex,
        plane = index === 2
      const viaPoint = plane ? { x: -1.6, y: 1.4 } : { x: 0, y: -index * 1.8 }
      const exitPoint = plane ? viaPoint : { x: 3, y: 1.38116 - index * 1.8 }
      // A post-matching endpoint stub is much smaller than either trace width or
      // routing-grid pitch. It still needs the same strict 45-degree guarantee.
      const targetLayerPoints = plane
        ? [viaPoint]
        : [
            viaPoint,
            ...(index === 0
              ? [
                  { x: 0.08068, y: 0.08068 },
                  { x: 0.08092, y: 0.08068 },
                ]
              : [{ x: 0.08092, y: 0.08092 - 1.8 }]),
            { x: 0.08092, y: 0.64964 - index * 1.8 },
            { x: 0.81244, y: 1.38116 - index * 1.8 },
            exitPoint,
          ]
      return buildViaMinimalWindingPlan({
        ...rules,
        layerNames,
        bus,
        terminal: { connection, viaPoint, exitPoint },
        targetLayer: plane ? "inner2" : "inner1",
        targetLayerPoints,
        allowBlindAndBuriedVias: false,
      })
    }),
  )
  const original = JSON.stringify({ inputSrj, preparedBuses, plans })
  expect(
    plans[0]!.segments[2]!.end.x - plans[0]!.segments[2]!.start.x,
  ).toBeCloseTo(0.00024, 8)
  const normalized = normalizeFanoutPlanCorners({
    ...rules,
    inputSrj,
    preparedBuses,
    plans,
    layerNames,
  })!
  expect(normalized).not.toBeNull()
  expect(normalized).toHaveLength(3)
  expect(JSON.stringify({ inputSrj, preparedBuses, plans })).toBe(original)
  expect(normalized[0]!.length).toBeLessThan(plans[0]!.length)
  expect(normalized[1]).toBe(plans[1])
  expect(normalized[2]).toBe(plans[2])
  for (let i = 0; i < plans.length; i++) {
    const before = plans[i]!,
      after = normalized[i]!
    expect(after.sourcePoint).toBe(before.sourcePoint)
    expect(after.via).toBe(before.via)
    expect(after.additionalVias).toBe(before.additionalVias)
    expect(after.exitPoint).toBe(before.exitPoint)
    expect(after.segments[0]).toBe(before.segments[0])
    const firstVia = before.trace.route.findIndex(
      (point) => point.route_type === "via",
    )
    for (let index = 0; index <= firstVia; index++)
      expect(after.trace.route[index]).toBe(before.trace.route[index])
    for (let index = 0; index < after.segments.length; index++) {
      const segment = after.segments[index]!,
        dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const next = after.segments[index + 1]
      if (next?.layer === segment.layer) {
        const nx = next.end.x - next.start.x,
          ny = next.end.y - next.start.y
        expect(
          (dx * nx + dy * ny) / (Math.hypot(dx, dy) * Math.hypot(nx, ny)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
      }
      if (after.termination.type === "boundary")
        for (const point of [segment.start, segment.end]) {
          if (Math.abs(point.x) >= 3 - 1e-7 || Math.abs(point.y) >= 3 - 1e-7)
            expect(point).toEqual(after.exitPoint)
        }
    }
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: normalized,
    layerNames,
  })
  expect(outputSrj.traces).toContainEqual(inputSrj.traces![0]!)
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans: normalized,
      preparedBuses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 3, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: {
        ...inputSrj,
        traces: [...inputSrj.traces!, ...normalized.map((plan) => plan.trace)],
      },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 4,
    checkedViaCount: 4,
    issues: [],
  })
  const badSource = {
    ...plans[0]!,
    sourceEscapeSegmentCount: 2,
    segments: [
      { ...plans[0]!.segments[0]!, end: { x: -0.325, y: 0 } },
      { ...plans[0]!.segments[0]!, start: { x: -0.325, y: 0 } },
      ...plans[0]!.segments.slice(1),
    ],
  }
  expect(
    normalizeFanoutPlanCorners({
      ...rules,
      inputSrj,
      preparedBuses,
      plans: [badSource, ...plans.slice(1)],
      layerNames,
    }),
  ).toBeNull()
  const sourceOnBoundary = {
    ...plans[0]!,
    segments: [
      { ...plans[0]!.segments[0]!, start: { x: -3, y: -3 } },
      ...plans[0]!.segments.slice(1),
    ],
  }
  expect(
    normalizeFanoutPlanCorners({
      ...rules,
      inputSrj,
      preparedBuses,
      plans: [sourceOnBoundary, ...plans.slice(1)],
      layerNames,
    }),
  ).toBeNull()
  const graphics = visualizeSimpleRouteJson({ ...outputSrj, connections: [] })
  graphics.texts ??= []
  graphics.lines ??= []
  // Centerline insets expose the 0.00024mm defect, which is otherwise hidden
  // by physical trace width in the complete board view.
  for (const [plan, offsetY, label] of [
    [plans[0]!, 2, "Before: 90 degree stub"],
    [normalized[0]!, -2, "After: 45 degree chamfer"],
  ] as const) {
    graphics.texts!.push({
      x: 6.5,
      y: offsetY + 1.7,
      text: label,
      fontSize: 0.22,
      anchorSide: "bottom_left",
    })
    for (const segment of plan.segments.filter((s) => s.layer === "inner1")) {
      let lo = 0,
        hi = 1
      for (const [axis, center] of [
        ["x", 0.08092],
        ["y", 0.08068],
      ] as const) {
        const from = segment.start[axis],
          delta = segment.end[axis] - from
        if (Math.abs(delta) < 1e-12) {
          if (Math.abs(from - center) > 0.0003) hi = -1
        } else {
          const a = (center - 0.0003 - from) / delta,
            b = (center + 0.0003 - from) / delta
          lo = Math.max(lo, Math.min(a, b))
          hi = Math.min(hi, Math.max(a, b))
        }
      }
      if (hi <= lo) continue
      graphics.lines!.push({
        points: [lo, hi].map((t) => ({
          x:
            8 +
            5000 *
              (segment.start.x +
                t * (segment.end.x - segment.start.x) -
                0.08092),
          y:
            offsetY +
            5000 *
              (segment.start.y +
                t * (segment.end.y - segment.start.y) -
                0.08068),
        })),
        strokeColor: "#2563eb",
        strokeWidth: 0.04,
      })
    }
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
