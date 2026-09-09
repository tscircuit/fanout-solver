import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { distanceSegmentToSegment } from "lib/geometry"
import {
  changedFanoutCopperIsSelfClear,
  normalizeFanoutPlanCorners,
} from "lib/normalize-fanout-plan-corners"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("normalization rejects new copper crossing a retained hairpin arm despite valid turns", async () => {
  const rules = {
    traceWidth: 0.08,
    clearance: 0.08,
    viaDiameter: 0.2,
    viaHoleDiameter: 0.1,
    layerNames: ["top", "bottom"],
  }
  const bounds = { minX: -2.5, maxX: 4.5, minY: -2.5, maxY: 4.5 }
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: rules.traceWidth,
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: -0.5 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        componentId: "U1",
        connectedTo: ["N"],
      },
    ],
    connections: [
      {
        name: "N",
        pointsToConnect: [
          { x: 0, y: -0.5, layer: "top" },
          { x: 4.5, y: 0, layer: "bottom" },
        ],
      },
    ],
  }
  const [bus] = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "data",
        sourceComponentId: "U1",
        connectionNames: ["N"],
        preferredExit: "right",
        allowedLayers: ["bottom"],
      },
    ],
  })
  const originalPoints = [
    { x: 0, y: 0 },
    { x: 0, y: 2 },
    { x: 2, y: 2 },
    { x: 2, y: 0.5 },
    { x: 2, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: -1.5, y: 4 },
    { x: -2, y: 4 },
    { x: -2, y: -2 },
    { x: 4.3, y: -2 },
    { x: 4.3, y: 0 },
    { x: 4.5, y: 0 },
  ]
  const route = normalizeLayeredPath({
    points: originalPoints.map((p) => ({ ...p, z: 1 })),
    chamfer: 0.02,
    segmentIsClear: () => true,
  })!
  const plan = buildViaMinimalWindingPlan({
    ...rules,
    bus: bus!,
    terminal: {
      connection: bus!.connections[0]!,
      viaPoint: originalPoints[0]!,
      exitPoint: originalPoints.at(-1)!,
    },
    targetLayer: "bottom",
    targetLayerPoints: route,
    allowBlindAndBuriedVias: false,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: [plan.trace] },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 1,
    checkedViaCount: 1,
    issues: [],
  })
  const cutStart = route.findIndex((p) => p.x === 2 && p.y === 0.5),
    cutEnd = route.findIndex((p) => p.x === -1.5 && p.y === 4)
  expect(cutStart).toBeGreaterThan(0)
  expect(cutEnd).toBeGreaterThan(cutStart)
  const points = [
    ...route.slice(0, cutStart + 1),
    ...[
      { x: 2, y: 0 },
      { x: 1.75, y: -0.25 },
      { x: 1.5, y: -0.25 },
      { x: 1.25, y: 0 },
      { x: 1.25, y: 2.5 },
      { x: 0.75, y: 3 },
      { x: 0.75, y: 3.5 },
      { x: 0.25, y: 4 },
    ],
    ...route.slice(cutEnd),
  ]
  const candidate = [
    plan.segments[0]!,
    ...points.slice(1).map((end, i) => ({
      start: points[i]!,
      end,
      layer: "bottom",
      width: rules.traceWidth,
    })),
  ]
  // The vertical shortcut arm crosses retained horizontal copper at (1.25,2).
  const crossing = candidate.find(
    (s) => s.start.x === 1.25 && s.end.x === 1.25 && s.end.y === 2.5,
  )!
  const retained = candidate.find(
    (s) => s.start.y === 2 && s.end.y === 2 && s.end.x > 1.25,
  )!
  expect(
    distanceSegmentToSegment(
      crossing.start,
      crossing.end,
      retained.start,
      retained.end,
    ),
  ).toBe(0)
  expect(
    changedFanoutCopperIsSelfClear(plan, plan.segments, rules.clearance),
  ).toBe(true)
  expect(changedFanoutCopperIsSelfClear(plan, candidate, rules.clearance)).toBe(
    false,
  )
  const lead = buildViaMinimalWindingPlan({
    ...rules,
    bus: bus!,
    targetLayer: "bottom",
    allowBlindAndBuriedVias: false,
    terminal: {
      connection: bus!.connections[0]!,
      viaPoint: { x: 0, y: 0 },
      exitPoint: { x: 4.5, y: 0 },
    },
    targetLayerPoints: [
      { x: 0, y: 0 },
      { x: 0.07, y: 0 },
      { x: 0.16, y: -0.09 },
      { x: 0.16, y: -0.16 },
      { x: 4, y: -0.16 },
      { x: 4.16, y: 0 },
      { x: 4.5, y: 0 },
    ],
  })
  // A bend can still be part of the outward via lead after its arclength
  // exceeds the clearance radius. Its radial distance never reverses.
  const radius = (rules.viaDiameter + rules.traceWidth) / 2 + rules.clearance
  expect(0.07 + Math.hypot(0.09, 0.09) + 0.05).toBeGreaterThan(radius)
  expect(Math.hypot(0.16, 0.14)).toBeLessThan(radius)
  const normalizedLead = normalizeFanoutPlanCorners({
    ...rules,
    inputSrj,
    preparedBuses: [bus!],
    plans: [lead],
  })
  expect(normalizedLead).toHaveLength(1)
  expect(normalizedLead![0]!.via).toBe(lead.via)
  expect(normalizedLead![0]!.segments[0]).toBe(lead.segments[0])
  for (let i = 0; i < candidate.length - 1; i++) {
    const a = candidate[i]!,
      b = candidate[i + 1]!
    if (a.layer !== b.layer) continue
    const ax = a.end.x - a.start.x,
      ay = a.end.y - a.start.y,
      bx = b.end.x - b.start.x,
      by = b.end.y - b.start.y
    expect(
      (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)),
    ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
  }
  const graphics: GraphicsObject = { lines: [], texts: [] }
  for (const [segments, offset, label] of [
    [plan.segments, 0, "Original: clear hairpin"],
    [candidate, 8, "Rejected: shortcut crosses retained arm"],
  ] as const) {
    graphics.texts!.push({
      x: -2 + offset,
      y: 4.7,
      text: label,
      fontSize: 0.22,
      anchorSide: "bottom_left",
    })
    for (const s of segments)
      graphics.lines!.push({
        points: [s.start, s.end].map((p) => ({ x: p.x + offset, y: p.y })),
        strokeColor: offset ? "#dc2626" : "#2563eb",
        strokeWidth: s.width,
      })
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
