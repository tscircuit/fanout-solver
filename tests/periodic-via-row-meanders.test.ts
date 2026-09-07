import { expect, test } from "bun:test"
import "bun-match-svg"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { distance, distanceSegmentToSegment } from "../lib/geometry"
import { matchBusPlanLengthsWithPeriodicMeanders } from "../lib/match-bus-lengths"
import { plansPreserveSourcesAndCorners } from "../lib/plans-preserve-sources-and-corners"
import { fanoutPlansAreClear } from "../lib/route-bus"
import { chamferSplitPerimeter } from "../lib/route-split-perimeter-source-escapes"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

test("places length-matching teeth between native via rows without copper shortcuts", async () => {
  const width = 0.08128
  const clearance = width
  const boundary = { minX: -4, maxX: 1, minY: -4, maxY: 4 }
  const layerNames = ["top", "inner1", "bottom"]
  const sources = [
    { x: 0.5704, y: 3.25 },
    { x: -2, y: 3.575 },
  ]
  const viaRows = Array.from({ length: 10 }, (_, i) => (i - 5) * 0.65)
  const pads: Obstacle[] = [
    ...sources.map((center, i) => ({
      type: "rect" as const,
      shape: "circle" as const,
      center,
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      componentId: "U1",
      connectedTo: [`data-${i}`],
    })),
    ...viaRows.map((y, i) => ({
      type: "rect" as const,
      shape: "circle" as const,
      center: { x: -0.325, y: y + 0.325 },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      componentId: "U1",
      connectedTo: [`fixed-pad-${i}`],
    })),
  ]
  const connections = sources.map((point, i) => ({
    name: `data-${i}`,
    pointsToConnect: [
      { ...point, layer: "top", pointId: `source-${i}` },
      {
        x: i === 0 ? 0.2454 : -2.325,
        y: -5,
        layer: "inner1",
        pointId: `target-${i}`,
      },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: width,
    bounds: boundary,
    connections,
    obstacles: [
      ...pads,
      ...viaRows.map((y, i) => ({
        type: "rect" as const,
        shape: "circle" as const,
        center: { x: 0, y },
        width: 0.24,
        height: 0.24,
        layers: layerNames,
        connectedTo: [`reserved-via-${i}`],
      })),
      ...[-0.24228, 0.40796].map((x, i) => ({
        type: "rect" as const,
        center: { x, y: -0.7 },
        width,
        height: 6.6,
        layers: ["inner1"],
        connectedTo: [`guard-${i}`],
      })),
    ],
  }
  const prepared: PreparedConnection[] = connections.map((connection, i) => ({
    connection,
    connectionIndex: i,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: pads[i]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const bus: PreparedBus = {
    busId: "DATA",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -2.15, maxX: 0.7204, minY: -3.075, maxY: 3.725 },
    sharedBoundary: boundary,
    xCoordinates: [-0.325, 0.325],
    yCoordinates: viaRows.map((y) => y + 0.325),
    pitchX: 0.65,
    pitchY: 0.65,
    direction: "down",
    exitEdge: "bottom",
    preferredExit: "bottom",
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    termination: { type: "boundary" },
    connections: prepared,
    maxLengthSkew: 0,
  }
  const base = {
    srj,
    bus,
    targetLayer: "inner1",
    acceptedPlans: [],
    traceWidth: width,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames,
    allowBlindAndBuriedVias: false,
  }
  const routes = [
    [
      { x: 0.2454, y: 2.925 },
      { x: 0.2454, y: -4 },
    ],
    chamferSplitPerimeter(
      [
        { x: -2.325, y: 3.25 },
        { x: -3.7, y: 3.25 },
        { x: -3.7, y: -3.5 },
        { x: -2.325, y: -3.5 },
        { x: -2.325, y: -4 },
      ],
      width,
    ),
  ]
  const plans = prepared.map((connection, i) =>
    buildViaMinimalWindingPlan({
      ...base,
      terminal: {
        connection,
        viaPoint: routes[i]![0]!,
        exitPoint: routes[i]!.at(-1)!,
      },
      sourceEscapePoints: [connection.sourcePoint, routes[i]![0]!],
      targetLayerPoints: routes[i]!,
    }),
  )
  bus.maxLengthSkew = plans[1]!.length - plans[0]!.length - 2.5
  expect(bus.maxLengthSkew).toBeGreaterThan(0)
  expect(
    fanoutPlansAreClear({ ...base, plans, sharedBoundary: boundary }),
  ).toBe(true)
  const before = JSON.stringify({ srj, bus, plans })
  const params = {
    inputSrj: srj,
    plans,
    preparedBuses: [bus],
    sharedBoundary: boundary,
    clearance,
    allowBlindAndBuriedVias: false,
    allowMatchingInsideDenseBounds: true,
  }
  const result = matchBusPlanLengthsWithPeriodicMeanders(params)
  expect(result.plans).not.toBeNull()
  if (!result.plans) throw Error("Expected periodic via-row meanders")
  const tuned = result.plans[0]!
  expect(tuned.length - plans[0]!.length).toBeCloseTo(2.5, 5)
  expect(result.plans[1]).toBe(plans[1])
  expect(tuned.sourcePoint).toBe(plans[0]!.sourcePoint)
  expect(tuned.targetPoint).toBe(plans[0]!.targetPoint)
  expect(tuned.sourceObstacle).toBe(plans[0]!.sourceObstacle)
  expect(tuned.via).toEqual(plans[0]!.via)
  expect(tuned.segments[0]).toEqual(plans[0]!.segments[0])
  expect(JSON.stringify({ srj, bus, plans })).toBe(before)
  const sourceEscapes = plans.map((plan) => ({
    connectionIndex: plan.connectionIndex,
    connectionName: plan.connectionName,
    via: plan.via!,
    segments: [plan.segments[0]!],
  }))
  expect(
    plansPreserveSourcesAndCorners({
      plans: result.plans,
      preparedBuses: [bus],
      sourceEscapes,
    }),
  ).toBe(true)
  for (let i = 1; i < tuned.segments.length; i++)
    for (let j = i + 2; j < tuned.segments.length; j++) {
      const a = tuned.segments[i]!
      const b = tuned.segments[j]!
      const connectedLength = tuned.segments
        .slice(i + 1, j)
        .reduce((sum, segment) => sum + distance(segment.start, segment.end), 0)
      if (connectedLength <= width + clearance + 1e-7) continue
      expect(
        distanceSegmentToSegment(a.start, a.end, b.start, b.end) - width,
      ).toBeGreaterThanOrEqual(clearance - 1e-7)
    }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: result.plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({ ...params, plans: result.plans, outputSrj }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: outputSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    matchBusPlanLengthsWithPeriodicMeanders({
      ...params,
      candidatePlansAreFeasible: () => false,
    }).plans,
  ).toBeNull()
  expect(JSON.stringify({ srj, bus, plans })).toBe(before)
  expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: result.plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
