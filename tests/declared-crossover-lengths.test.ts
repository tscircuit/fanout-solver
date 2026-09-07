import { expect, test } from "bun:test"
import "bun-match-svg"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { matchBusPlanLengths } from "../lib/match-bus-lengths"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
  RoutedVia,
} from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

type RoutePoint = readonly [x: number, y: number, layer: string]

function makeFixture() {
  const width = 0.1
  const clearance = 0.1
  const layerNames = ["top", "inner1", "bottom"]
  const boundary = { minX: -4, maxX: 4, minY: -4, maxY: 4 }
  const definitions = [
    { name: "DIRECT", x: 2.5, y: 2.5, targetY: 3.1 },
    { name: "BRIDGED", x: -2.5, y: -1, targetY: 1 },
    { name: "WALL", x: 3.7, y: 0, targetY: 0 },
  ]
  const pads = definitions.map((d, i) => ({
    type: "rect" as const,
    center: { x: d.x, y: d.y },
    width: i === 2 ? 0.6 : 0.3,
    height: 0.3,
    layers: [i === 2 ? "bottom" : "top"],
    componentId: i === 2 ? "U2" : "U1",
    connectedTo: [d.name],
  }))
  const connections = definitions.map((d, i) => ({
    name: d.name,
    pointsToConnect: [
      {
        ...pads[i]!.center,
        layer: pads[i]!.layers[0]!,
        pointId: `source-${i}`,
      },
      { x: -5, y: d.targetY, layer: "bottom", pointId: `target-${i}` },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: layerNames.length,
    minTraceWidth: width,
    bounds: boundary,
    obstacles: pads,
    connections,
  }
  const prepared: PreparedConnection[] = connections.map((connection, i) => ({
    connection,
    connectionIndex: i,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: pads[i]!.layers[0]!,
    sourceObstacle: pads[i]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const bus: PreparedBus = {
    busId: "DATA",
    componentId: "U1",
    componentObstacles: pads.slice(0, 2),
    componentBounds: { minX: -2.65, maxX: 2.65, minY: -1.15, maxY: 2.65 },
    sharedBoundary: boundary,
    xCoordinates: [-2.5, 2.5],
    yCoordinates: [-1, 2.5],
    pitchX: 2,
    pitchY: 2,
    termination: { type: "boundary" },
    connections: prepared.slice(0, 2),
    direction: "up",
    exitEdge: "left",
    preferredExit: "top-left",
    allowedLayers: ["inner1", "bottom"],
    routableEscapeLayers: ["inner1", "bottom"],
    maxLengthSkew: 0.2,
  }
  const wallBus: PreparedBus = {
    ...bus,
    busId: "WALL",
    componentId: "U2",
    componentObstacles: [pads[2]!],
    componentBounds: { minX: 3.4, maxX: 4, minY: -0.15, maxY: 0.15 },
    connections: [prepared[2]!],
    direction: "left",
    preferredExit: "left",
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
  }
  function makePlan(
    index: number,
    points: readonly RoutePoint[],
  ): FanoutRoutePlan {
    const connection = prepared[index]!
    const planBus = index === 2 ? wallBus : bus
    const segments: RoutedSegment[] = []
    const vias: RoutedVia[] = []
    const route: FanoutRoutePlan["trace"]["route"] = []
    let sourceEscapeSegmentCount = 0
    for (const [i, [x, y, layer]] of points.entries()) {
      const previous = points[i - 1]
      if (previous && previous[2] !== layer) {
        if (previous[0] !== x || previous[1] !== y)
          throw Error("Via must not move")
        vias.push({
          center: { x, y },
          diameter: 0.24,
          holeDiameter: 0.1,
          spanLayers: [...layerNames],
          fromLayer: previous[2],
          toLayer: layer,
        })
        route.push({
          route_type: "via",
          x,
          y,
          from_layer: previous[2],
          to_layer: layer,
          via_diameter: 0.24,
          via_hole_diameter: 0.1,
        })
      } else if (previous) {
        segments.push({
          start:
            i === 1
              ? connection.sourcePoint
              : { x: previous[0], y: previous[1] },
          end: { x, y },
          width,
          layer,
        })
        if (vias.length === 0) sourceEscapeSegmentCount++
      }
      route.push({
        route_type: "wire",
        ...(i === 0 ? connection.sourcePoint : { x, y }),
        width,
        layer,
      })
    }
    const last = points.at(-1)!
    return {
      ...connection,
      sourceObstacle: pads[index]!,
      busId: planBus.busId,
      connectionName: connection.connection.name,
      targetLayer: "bottom",
      termination: { type: "boundary" },
      direction: planBus.direction,
      exitEdge: "left",
      ...(index !== 2 ? { cornerBandSide: "maximum" as const } : {}),
      exitPoint: { x: last[0], y: last[1] },
      segments,
      ...(vias.length ? { via: vias[0], sourceEscapeSegmentCount } : {}),
      ...(vias.length > 1 ? { additionalVias: vias.slice(1) } : {}),
      length: segments.reduce(
        (sum, s) => sum + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y),
        0,
      ),
      trace: {
        type: "pcb_trace",
        pcb_trace_id: `fanout:${connection.connection.name}:source-0`,
        connection_name: connection.connection.name,
        route,
      },
    }
  }
  const wall = makePlan(2, [
    [3.7, 0, "bottom"],
    [-4, 0, "bottom"],
  ])
  const direct = makePlan(0, [
    [2.5, 2.5, "top"],
    [2.85, 2.85, "top"],
    [2.85, 2.85, "bottom"],
    [2.8, 2.9, "bottom"],
    [-3.8, 2.9, "bottom"],
    [-4, 3.1, "bottom"],
  ])
  const bridgePrefix: RoutePoint[] = [
    [-2.5, -1, "top"],
    [-2.15, -0.65, "top"],
    [-2.15, -0.65, "inner1"],
  ]
  // The bottom wall forces this route to cross on inner1. Its short bottom
  // tail has too little room for matching, while the declared inner1 leg is open.
  const bridged = makePlan(1, [
    ...bridgePrefix,
    [-3.6, 0.8, "inner1"],
    [-3.6, 1, "inner1"],
    [-3.6, 1, "bottom"],
    [-4, 1, "bottom"],
  ])
  const widerPrefix: RoutePoint[] = [
    ...bridgePrefix,
    [-2.3, -0.5, "inner1"],
    [-2.3, 0.9, "inner1"],
    [-2.4, 1, "inner1"],
    [-2.4, 1, "bottom"],
  ]
  const widerTail = makePlan(1, [...widerPrefix, [-4, 1, "bottom"]])
  // Captured target-layer-only success: introducing the fallback must preserve it.
  const ordinaryExpected = makePlan(1, [
    ...widerPrefix,
    [-2.5, 1, "bottom"],
    [-2.6, 1.1, "bottom"],
    [-2.6, 1.8671575375253813, "bottom"],
    [-2.7, 1.9671575375253814, "bottom"],
    [-2.9, 1.9671575375253814, "bottom"],
    [-3, 1.8671575375253813, "bottom"],
    [-3, 1.1, "bottom"],
    [-3.1, 1, "bottom"],
    [-3.3, 1, "bottom"],
    [-3.4, 1.1, "bottom"],
    [-3.4, 1.8671575375253813, "bottom"],
    [-3.5, 1.9671575375253814, "bottom"],
    [-3.7, 1.9671575375253814, "bottom"],
    [-3.8, 1.8671575375253813, "bottom"],
    [-3.8, 1.1, "bottom"],
    [-3.9, 1, "bottom"],
    [-4, 1, "bottom"],
  ])
  const sourceOnlyPrefix = makePlan(1, [
    [-2.5, -1, "top"],
    [-3.5, 0, "top"],
    [-3.5, 1, "top"],
    [-3.5, 1, "bottom"],
    [-4, 1, "bottom"],
  ])
  return {
    srj,
    bus,
    wallBus,
    layerNames,
    boundary,
    clearance,
    makePlan,
    wall,
    direct,
    bridged,
    widerTail,
    ordinaryExpected,
    sourceOnlyPrefix,
  }
}

function geometry(plan: FanoutRoutePlan) {
  const round = (n: number) => Math.round(n * 1e8) / 1e8
  return {
    length: round(plan.length),
    segments: plan.segments.map((s) => [
      s.layer,
      ...[s.start.x, s.start.y, s.end.x, s.end.y].map(round),
    ]),
    via: plan.via,
    additionalVias: plan.additionalVias,
  }
}

test("matches a declared crossover while preserving source prefixes, vias, and existing target-layer results", async () => {
  const f = makeFixture()
  const plans = [f.wall, f.direct, f.bridged]
  const matching = {
    plans,
    preparedBuses: [f.bus],
    inputSrj: f.srj,
    sharedBoundary: f.boundary,
    clearance: f.clearance,
    allowBlindAndBuriedVias: false,
    allowMatchingInsideDenseBounds: true,
  }
  const before = JSON.stringify(plans)
  const matched = matchBusPlanLengths(matching).plans
  expect(matched).not.toBeNull()
  if (!matched) throw Error("Expected legal crossover matching")
  expect(JSON.stringify(plans)).toBe(before)
  for (const plan of matched) {
    const original = plans.find(
      (p) => p.connectionIndex === plan.connectionIndex,
    )!
    expect(plan.via).toEqual(original.via)
    expect(plan.additionalVias).toEqual(original.additionalVias)
    expect(plan.sourcePoint).toEqual(original.sourcePoint)
    expect(plan.sourceObstacle).toBe(original.sourceObstacle)
    expect(plan.targetPoint).toEqual(original.targetPoint)
    expect(plan.exitPoint).toEqual(original.exitPoint)
    expect(plan.targetLayer).toBe(original.targetLayer)
    if (plan.via) {
      expect(
        plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1),
      ).toEqual(
        original.segments.slice(0, original.sourceEscapeSegmentCount ?? 1),
      )
    }
  }
  const bridged = matched.find((p) => p.connectionName === "BRIDGED")!
  expect(
    bridged.segments.filter((s) => s.layer === "inner1").length,
  ).toBeGreaterThan(
    f.bridged.segments.filter((s) => s.layer === "inner1").length,
  )
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: f.srj,
    plans: matched,
    layerNames: f.layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: f.srj,
      outputSrj,
      plans: matched,
      preparedBuses: [f.bus, f.wallBus],
      sharedBoundary: f.boundary,
      clearance: f.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 3, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: f.srj,
      routedSrj: outputSrj,
      clearance: f.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    matchBusPlanLengths({
      ...matching,
      preparedBuses: [
        {
          ...f.bus,
          allowedLayers: ["bottom"],
          routableEscapeLayers: ["bottom"],
        },
      ],
    }).plans,
  ).toBeNull()
  const prefixPlans = [f.wall, f.direct, f.sourceOnlyPrefix]
  const prefixBefore = JSON.stringify(prefixPlans)
  const sourcePrefixBus: PreparedBus = {
    ...f.bus,
    allowedLayers: ["top", "bottom"],
    routableEscapeLayers: ["top", "bottom"],
  }
  const prefixMatched = matchBusPlanLengths({
    ...matching,
    plans: prefixPlans,
    preparedBuses: [sourcePrefixBus],
  }).plans
  expect(prefixMatched).not.toBeNull()
  if (!prefixMatched) throw Error("Expected short-tail narrow-chamfer matching")
  const prefixRoute = prefixMatched.find(
    (plan) => plan.connectionIndex === f.sourceOnlyPrefix.connectionIndex,
  )!
  expect(
    prefixRoute.segments.slice(0, f.sourceOnlyPrefix.sourceEscapeSegmentCount),
  ).toEqual(
    f.sourceOnlyPrefix.segments.slice(
      0,
      f.sourceOnlyPrefix.sourceEscapeSegmentCount,
    ),
  )
  expect(prefixRoute.via).toEqual(f.sourceOnlyPrefix.via)
  expect(
    prefixRoute.segments
      .slice(f.sourceOnlyPrefix.sourceEscapeSegmentCount)
      .every((segment) => segment.layer === "bottom"),
  ).toBe(true)
  const prefixOutput = buildOutputSimpleRouteJson({
    inputSrj: f.srj,
    plans: prefixMatched,
    layerNames: f.layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: f.srj,
      outputSrj: prefixOutput,
      plans: prefixMatched,
      preparedBuses: [sourcePrefixBus, f.wallBus],
      sharedBoundary: f.boundary,
      clearance: f.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: f.srj,
      routedSrj: prefixOutput,
      clearance: f.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(JSON.stringify(prefixPlans)).toBe(prefixBefore)
  const ordinary = matchBusPlanLengths({
    ...matching,
    plans: [f.wall, f.direct, f.widerTail],
  }).plans
  expect(ordinary).not.toBeNull()
  if (!ordinary) throw Error("Expected original target-layer matching")
  expect(ordinary.map(geometry)).toEqual(
    [f.wall, f.direct, f.ordinaryExpected].map(geometry),
  )
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...f.srj,
        connections: [],
        traces: matched.map((p) => p.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
