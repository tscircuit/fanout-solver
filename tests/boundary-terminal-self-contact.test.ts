import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import {
  appendBoundaryTerminalApproach,
  boundaryTerminalPlanIsSelfClear,
  createBoundaryTerminalConnector,
  repairBoundaryTerminalEntries,
} from "lib/boundary-terminal-connectors"
import { distance, distanceSegmentToSegment } from "lib/geometry"
import { changedFanoutCopperIsSelfClear } from "lib/normalize-fanout-plan-corners"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import type {
  FanoutRoutePlan,
  Point2D,
  RoutedSegment,
  RoutedVia,
} from "lib/types"

test("terminal elbows reject retained same-net arms before and after corner normalization", async () => {
  const width = 0.08128,
    clearance = 0.08128
  const connector = createBoundaryTerminalConnector({
    connectionName: "lane",
    edge: "right",
    layer: "bottom",
    exit: { x: 5, y: 2.13 },
    bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 },
    approachLength: 1,
  })
  const sourcePoint = { x: 4, y: 3.5, layer: "top" }
  const viaPoint = { x: 4, y: 3 }
  const sourceSegment: RoutedSegment = {
    start: sourcePoint,
    end: viaPoint,
    layer: "top",
    width,
  }
  const sourceObstacle = {
    type: "rect" as const,
    center: sourcePoint,
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: ["lane"],
  }
  const makePlan = (points: readonly Point2D[]): FanoutRoutePlan => {
    const segments = [
      sourceSegment,
      ...points.slice(1).map((end, i) => ({
        start: points[i]!,
        end,
        layer: "bottom",
        width,
      })),
    ]
    return {
      busId: "data",
      connectionName: "lane",
      connectionIndex: 0,
      sourcePointIndex: 0,
      sourcePoint,
      sourceObstacle,
      sourceLayer: "top",
      sourceEscapeSegmentCount: 1,
      targetLayer: "bottom",
      targetPoint: { ...connector.exit, layer: "bottom" },
      termination: { type: "boundary" },
      direction: "right",
      exitPoint: connector.exit,
      via: {
        center: viaPoint,
        diameter: 0.24,
        holeDiameter: 0.1,
        fromLayer: "top",
        toLayer: "bottom",
        spanLayers: ["top", "bottom"],
      },
      trace: {
        type: "pcb_trace",
        pcb_trace_id: "lane-trace",
        connection_name: "lane",
        route: [
          ...[sourcePoint, viaPoint].map((p) => ({
            route_type: "wire" as const,
            ...p,
            layer: "top",
            width,
          })),
          {
            route_type: "via",
            ...viaPoint,
            from_layer: "top",
            to_layer: "bottom",
            via_diameter: 0.24,
            via_hole_diameter: 0.1,
          },
          ...points.map((p) => ({
            route_type: "wire" as const,
            ...p,
            layer: "bottom",
            width,
          })),
        ],
      },
      segments,
      length: segments.reduce((sum, s) => sum + distance(s.start, s.end), 0),
    }
  }
  const retained = [
    viaPoint,
    { x: 3, y: 3 },
    { x: 3, y: 2 },
    { x: 1, y: 2 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ]
  const raw = {
    connectionName: "lane",
    route: [...retained, connector.goal].map((p) => ({ ...p, z: 1 })),
    vias: [],
  }
  const original = JSON.stringify(raw)
  const emitted = appendBoundaryTerminalApproach(raw, connector, {
    x: 4,
    y: 2,
  })
  const rawPlan = makePlan(emitted.route)
  const normalized = normalizeLayeredPath({
    points: emitted.route,
    chamfer: 0.02,
    // Same-net geometry is exempt from the ordinary foreign-copper callback.
    segmentIsClear: () => true,
  })!
  expect(normalized).not.toBeNull()
  const normalizedPlan = makePlan(normalized)
  const params = {
    splice: {
      rawSegments: rawPlan.segments,
      firstEntrySegmentIndex: makePlan(retained).segments.length,
    },
    maximumJoinLength: 0.02,
    clearance,
  }
  // The native straight final link misses this earlier arm. Its emitted elbow
  // touches the arm; corner normalization leaves only a 14-micrometer gap.
  expect(
    distanceSegmentToSegment(
      retained.at(-1)!,
      connector.goal,
      retained[1]!,
      retained[2]!,
    ),
  ).toBeGreaterThan(width + clearance)
  expect(
    distanceSegmentToSegment(
      { x: 2, y: 1 },
      { x: 3.13, y: 2.13 },
      { x: 3, y: 2.98 },
      { x: 3, y: 2.02 },
    ),
  ).toBeLessThan(width + clearance)
  expect(boundaryTerminalPlanIsSelfClear({ ...params, plan: rawPlan })).toBe(
    false,
  )
  expect(
    boundaryTerminalPlanIsSelfClear({ ...params, plan: normalizedPlan }),
  ).toBe(false)
  expect(rawPlan.via!.center).toBe(viaPoint)
  expect(normalizedPlan.segments[0]).toBe(sourceSegment)
  expect(JSON.stringify(raw)).toBe(original)

  const clearPrefix = [viaPoint, { x: 1, y: 3 }, { x: 1, y: 1 }, { x: 2, y: 1 }]
  const clear = appendBoundaryTerminalApproach(
    {
      ...raw,
      route: [...clearPrefix, connector.goal].map((p) => ({ ...p, z: 1 })),
    },
    connector,
    { x: 4, y: 2 },
  )
  const normalizedClear = normalizeLayeredPath({
    points: clear.route,
    chamfer: 0.02,
    segmentIsClear: () => true,
  })
  expect(normalizedClear).not.toBeNull()
  const clearPlan = makePlan(normalizedClear!)
  expect(
    boundaryTerminalPlanIsSelfClear({
      ...params,
      splice: {
        rawSegments: makePlan(clear.route).segments,
        firstEntrySegmentIndex: makePlan(clearPrefix).segments.length,
      },
      plan: clearPlan,
    }),
  ).toBe(true)

  const repaired = repairBoundaryTerminalEntries({
    plans: [rawPlan],
    splices: new Map([["lane", params.splice]]),
    connectors: new Map([["lane", connector]]),
    clearance,
    segmentIsClear: () => true,
  })
  expect(repaired).not.toBeNull()
  const foreign = {
    ...clearPlan,
    connectionName: "foreign",
    connectionIndex: 1,
    via: undefined,
    segments: [
      {
        start: { x: 2.7, y: 0.8 },
        end: { x: 2.7, y: 1.2 },
        layer: "bottom",
        width,
      },
    ],
  }
  for (const obstacle of [
    foreign,
    {
      ...foreign,
      segments: [],
      via: { ...rawPlan.via!, center: { x: 2.7, y: 1 } },
    },
  ]) {
    expect(
      repairBoundaryTerminalEntries({
        plans: [rawPlan, obstacle],
        splices: new Map([["lane", params.splice]]),
        connectors: new Map([["lane", connector]]),
        clearance,
        segmentIsClear: () => true,
      }),
    ).toBeNull()
  }

  // Native grid steps can be shorter than the final join chamfer. The cut
  // must use the complete incoming run after the converter merges those steps.
  const splitIncoming = [
    viaPoint,
    { x: 1, y: 3 },
    { x: 1, y: 2 },
    { x: 3.99, y: 2 },
    { x: 4, y: 2 },
    { x: 4, y: 1 },
  ]
  const splitRaw = makePlan(splitIncoming)
  const mergedNormalized = normalizeLayeredPath({
    points: splitIncoming
      .filter((p) => p.x !== 3.99)
      .map((p) => ({ ...p, z: 1 })),
    chamfer: 0.02,
    segmentIsClear: () => true,
  })!
  expect(mergedNormalized).not.toBeNull()
  expect(
    boundaryTerminalPlanIsSelfClear({
      ...params,
      plan: makePlan(mergedNormalized),
      splice: {
        rawSegments: splitRaw.segments,
        firstEntrySegmentIndex: splitRaw.segments.length - 1,
      },
    }),
  ).toBe(true)

  // A merged long run contains old copper far from the entry. Split the audit
  // at its ordered splice rather than treating that whole retained run as new.
  const tightPrefix = [
    viaPoint,
    { x: 1, y: 3 },
    { x: 1, y: 2.15 },
    { x: 3, y: 2.15 },
    { x: 3, y: 2.3 },
    { x: 1.5, y: 2.3 },
    { x: 1.5, y: 2 },
    { x: 4, y: 2 },
    { x: 5, y: 2 },
  ]
  const tightRaw = makePlan(tightPrefix)
  const tightMerged = makePlan(
    tightPrefix.filter((p) => !(p.x === 4 && p.y === 2)),
  )
  expect(
    changedFanoutCopperIsSelfClear(
      tightMerged,
      tightMerged.segments,
      clearance,
      new Set([tightMerged.segments.length - 1]),
    ),
  ).toBe(false)
  expect(
    boundaryTerminalPlanIsSelfClear({
      ...params,
      plan: tightMerged,
      splice: {
        rawSegments: tightRaw.segments,
        firstEntrySegmentIndex: tightRaw.segments.length - 1,
      },
    }),
  ).toBe(true)

  // A later through-via may coincide with an earlier TOP endpoint without
  // joining that part of the ordered path. Same-net endpoint exemptions must
  // not turn that nonadjacent arm into an electrical shortcut.
  const firstTransit = { x: 2.5, y: 1.5 },
    secondTransit = { x: 3.13, y: 2.13 }
  const makeTransitPlan = (topPrefix: Point2D[]): FanoutRoutePlan => {
    const through = (
      center: Point2D,
      fromLayer: string,
      toLayer: string,
    ): RoutedVia => ({
      center,
      diameter: 0.24,
      holeDiameter: 0.1,
      fromLayer,
      toLayer,
      spanLayers: ["top", "inner1", "bottom"],
    })
    const vias = [
      through(viaPoint, "top", "bottom"),
      through(firstTransit, "bottom", "inner1"),
      through(secondTransit, "inner1", "bottom"),
    ]
    const points = [
      ...topPrefix.map((p) => ({ ...p, layer: "top" })),
      ...[...clearPrefix, firstTransit].map((p) => ({ ...p, layer: "bottom" })),
      ...[firstTransit, secondTransit].map((p) => ({ ...p, layer: "inner1" })),
      ...[secondTransit, connector.goal, connector.exit].map((p) => ({
        ...p,
        layer: "bottom",
      })),
    ]
    const route: FanoutRoutePlan["trace"]["route"] = []
    const segments: RoutedSegment[] = []
    for (const [i, point] of points.entries()) {
      const previous = points[i - 1]
      if (previous?.layer === point.layer)
        segments.push({
          start: previous,
          end: point,
          layer: point.layer,
          width,
        })
      else if (previous)
        route.push({
          route_type: "via",
          x: point.x,
          y: point.y,
          from_layer: previous.layer,
          to_layer: point.layer,
          via_diameter: 0.24,
          via_hole_diameter: 0.1,
        })
      route.push({ route_type: "wire", ...point, width })
    }
    return {
      ...clearPlan,
      sourceEscapeSegmentCount: topPrefix.length - 1,
      via: vias[0],
      additionalVias: vias.slice(1),
      segments,
      trace: { ...clearPlan.trace, route },
      length: segments.reduce(
        (sum, segment) => sum + distance(segment.start, segment.end),
        0,
      ),
    }
  }
  const transitClear = makeTransitPlan([sourcePoint, viaPoint])
  expect(
    boundaryTerminalPlanIsSelfClear({
      ...params,
      plan: transitClear,
      splice: {
        rawSegments: transitClear.segments,
        firstEntrySegmentIndex: transitClear.segments.findIndex(
          (s) =>
            distance(s.start, clearPrefix.at(-1)!) < 1e-8 &&
            s.layer === "bottom",
        ),
      },
    }),
  ).toBe(true)
  const barrelShortcut = makeTransitPlan([
    sourcePoint,
    { x: 2, y: 3.5 },
    { x: 2, y: 1.5 },
    firstTransit,
    { x: 3.5, y: 1.5 },
    { x: 4, y: 2 },
    viaPoint,
  ])
  expect(
    boundaryTerminalPlanIsSelfClear({
      ...params,
      plan: barrelShortcut,
      splice: {
        rawSegments: barrelShortcut.segments,
        firstEntrySegmentIndex: barrelShortcut.segments.findIndex(
          (s) =>
            distance(s.start, clearPrefix.at(-1)!) < 1e-8 &&
            s.layer === "bottom",
        ),
      },
    }),
  ).toBe(false)

  const graphics: GraphicsObject = { lines: [], texts: [] }
  for (const [plan, offset, label] of [
    [clearPlan, 0, "Accepted: clear terminal entry"],
    [normalizedPlan, 6, "Rejected: entry touches an earlier arm"],
    [repaired!.plans[0]!, 12, "Accepted: alternate entry clears the arm"],
  ] as const) {
    graphics.texts!.push({
      x: 0.7 + offset,
      y: 3.8,
      text: label,
      fontSize: 0.18,
      anchorSide: "bottom_left",
    })
    for (const segment of plan.segments)
      graphics.lines!.push({
        points: [segment.start, segment.end].map((p) => ({
          x: p.x + offset,
          y: p.y,
        })),
        strokeColor: offset === 6 ? "#dc2626" : "#2563eb",
        strokeWidth: width,
      })
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
