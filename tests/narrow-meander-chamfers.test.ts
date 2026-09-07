import { expect, test } from "bun:test"
import "bun-match-svg"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import {
  matchBusPlanLengths,
  matchBusPlanLengthsIncrementally,
} from "../lib/match-bus-lengths"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

test("smaller 45-degree chamfers tune a long tail inside a narrow copper corridor", async () => {
  const width = 0.08128
  const clearance = width
  const boundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const layerNames = ["top", "inner1", "bottom"]
  const points = [
    { x: 0.325, y: 4.125 },
    { x: 2.325, y: 4.125 },
  ]
  const pads = points.map((center, i) => ({
    type: "rect" as const,
    shape: "circle" as const,
    center,
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`data-${i}`],
  }))
  const connections = points.map((p, i) => ({
    name: `data-${i}`,
    pointsToConnect: [
      { ...p, layer: "top", pointId: `pad-${i}` },
      { x: i * 2, y: -6, layer: "bottom", pointId: `target-${i}` },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: width,
    bounds: boundary,
    connections,
    obstacles: [
      ...pads,
      ...[-1, 1].map((sign) => ({
        type: "rect" as const,
        center: { x: sign * 0.32128, y: -0.475 },
        width,
        height: 8.35,
        layers: ["bottom"],
        connectedTo: [`wall-${sign}`],
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
    componentBounds: { minX: 0.175, maxX: 2.475, minY: 3.975, maxY: 4.275 },
    sharedBoundary: boundary,
    xCoordinates: points.map((p) => p.x),
    yCoordinates: [4.125],
    pitchX: 2,
    pitchY: 2,
    direction: "down",
    exitEdge: "bottom",
    preferredExit: "bottom",
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    termination: { type: "boundary" },
    connections: prepared,
    maxLengthSkew: 0,
  }
  const base = {
    srj,
    bus,
    targetLayer: "bottom",
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
      { x: 0, y: 3.8 },
      { x: 0, y: -5 },
    ],
    [
      { x: 2, y: 3.8 },
      { x: 4.2, y: 3.8 },
      { x: 4.4, y: 3.6 },
      { x: 4.4, y: -4.4 },
      { x: 4.2, y: -4.6 },
      { x: 2.2, y: -4.6 },
      { x: 2, y: -4.8 },
      { x: 2, y: -5 },
    ],
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
  bus.maxLengthSkew = plans[1]!.length - plans[0]!.length - 2.4
  const snapshot = JSON.stringify({ srj, bus, plans })
  const params = {
    plans,
    preparedBuses: [bus],
    inputSrj: srj,
    sharedBoundary: boundary,
    clearance,
    allowBlindAndBuriedVias: false,
    allowMatchingInsideDenseBounds: true,
  }
  const matched = matchBusPlanLengths(params)
  expect(matched.plans).not.toBeNull()
  if (!matched.plans) throw Error("Expected narrow corridor matching")
  expect(JSON.stringify({ srj, bus, plans })).toBe(snapshot)
  const short = matched.plans.find((p) => p.connectionIndex === 0)!
  const long = matched.plans.find((p) => p.connectionIndex === 1)!
  expect(long).toBe(plans[1])
  expect(short.length - plans[0]!.length).toBeGreaterThanOrEqual(2.4)
  expect(Math.abs(long.length - short.length)).toBeLessThanOrEqual(
    bus.maxLengthSkew + 1e-6,
  )
  expect(short.sourceObstacle).toBe(prepared[0]!.sourceObstacle)
  expect(short.sourcePoint).toBe(prepared[0]!.sourcePoint)
  expect(short.targetPoint).toBe(prepared[0]!.targetPoint)
  expect(short.via).toEqual(plans[0]!.via)
  expect(short.additionalVias).toEqual(plans[0]!.additionalVias)
  expect(short.segments[0]).toEqual(plans[0]!.segments[0])
  for (const [i, seg] of short.segments.entries()) {
    const dx = seg.end.x - seg.start.x
    const dy = seg.end.y - seg.start.y
    expect(
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ),
    ).toBeLessThan(1e-7)
    const prev = short.segments[i - 1]
    if (prev?.layer === seg.layer) {
      const px = prev.end.x - prev.start.x
      const py = prev.end.y - prev.start.y
      expect(
        (px * dx + py * dy) / (Math.hypot(px, py) * Math.hypot(dx, dy)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: matched.plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans: matched.plans,
      preparedBuses: [bus],
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 2, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const fragmented: SimpleRouteJson = {
    ...srj,
    obstacles: [
      ...srj.obstacles,
      ...[-1, 1].map((sign) => ({
        type: "rect" as const,
        center: { x: sign * 2 * width, y: 0 },
        width,
        height: 1,
        layers: ["bottom"],
        connectedTo: [`neck-${sign}`],
      })),
    ],
  }
  const incremental = matchBusPlanLengthsIncrementally({
    ...params,
    inputSrj: fragmented,
  })
  expect(incremental.plans).not.toBeNull()
  if (!incremental.plans) throw Error("Expected separate tuning windows")
  expect(incremental.plans[1]).toBe(plans[1])
  expect(incremental.plans[0]!.sourcePoint).toBe(plans[0]!.sourcePoint)
  expect(incremental.plans[0]!.via).toEqual(plans[0]!.via)
  expect(incremental.plans[0]!.segments[0]).toEqual(plans[0]!.segments[0])
  expect(JSON.stringify({ srj, bus, plans })).toBe(snapshot)
  const incrementalOutput = buildOutputSimpleRouteJson({
    inputSrj: fragmented,
    plans: incremental.plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: fragmented,
      outputSrj: incrementalOutput,
      plans: incremental.plans,
      preparedBuses: [bus],
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: fragmented,
      routedSrj: incrementalOutput,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const protectedRight = matchBusPlanLengthsIncrementally({
    ...params,
    inputSrj: fragmented,
    candidatePlansAreFeasible: (candidatePlans) =>
      candidatePlans[0]!.segments
        .slice(1)
        .every((segment) => segment.start.x <= 1e-7 && segment.end.x <= 1e-7),
  })
  expect(protectedRight.plans).not.toBeNull()
  expect(
    protectedRight.plans?.[0]?.segments
      .slice(1)
      .every((segment) => segment.start.x <= 1e-7 && segment.end.x <= 1e-7),
  ).toBe(true)
  expect(JSON.stringify({ srj, bus, plans })).toBe(snapshot)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...fragmented,
        connections: [],
        traces: incremental.plans.map((p) => p.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path, "fragmented-windows")
  const openParams = { ...params, inputSrj: { ...srj, obstacles: pads } }
  const openResult = matchBusPlanLengths(openParams)
  expect(openResult.plans).not.toBeNull()
  const firstChamfer = openResult.plans?.[0]?.segments
    .slice(1)
    .find(
      (segment) =>
        Math.abs(segment.end.x - segment.start.x) > 1e-7 &&
        Math.abs(segment.end.y - segment.start.y) > 1e-7,
    )
  expect(firstChamfer).toBeDefined()
  expect(Math.abs(firstChamfer!.end.x - firstChamfer!.start.x)).toBeCloseTo(
    (width + clearance) / 2,
    7,
  )
  const unconstrained = {
    ...bus,
    maxLengthSkew: plans[1]!.length - plans[0]!.length + 1,
  }
  const unchanged = matchBusPlanLengths({
    ...params,
    preparedBuses: [unconstrained],
  })
  expect(unchanged.plans).toEqual(plans)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: matched.plans.map((p) => p.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 30_000)
