import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  boundaryTerminalPlanIsSelfClear,
  createBoundaryTerminalConnector,
  getBoundaryTerminalEntry,
  repairBoundaryTerminalEntries,
} from "lib/boundary-terminal-connectors"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { distance, distanceSegmentToObstacle } from "lib/geometry"
import { createPlanWithSegments } from "lib/match-bus-lengths"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("removes a short returning terminal arm while retaining its source, via and exact exit", async () => {
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const bounds = { minX: 0, maxX: 0.8, minY: -0.45, maxY: 1.1 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const sourcePoint = { x: 0.40824, y: 0.8, layer: "top", pointId: "source" }
  const viaPoint = { x: 0.40824, y: 0.24088 }
  const targetPoint = { x: 0.2628, y: -1, layer: "inner2" }
  const sourceObstacle = {
    type: "rect" as const,
    center: sourcePoint,
    width: 0.14,
    height: 0.14,
    layers: ["top"],
    connectedTo: ["lane"],
  }
  const connection: PreparedConnection = {
    connection: { name: "lane", pointsToConnect: [sourcePoint, targetPoint] },
    connectionIndex: 0,
    sourcePointIndex: 0,
    sourcePoint,
    sourceLayer: "top",
    sourceObstacle,
    targetPoint,
  }
  const bus: PreparedBus = {
    busId: "data",
    direction: "down",
    exitEdge: "bottom",
    preferredExit: "bottom",
    componentId: "U1",
    componentObstacles: [sourceObstacle],
    componentBounds: { minX: 0.33824, maxX: 0.47824, minY: 0.73, maxY: 0.87 },
    sharedBoundary: bounds,
    pitchX: 0.5,
    pitchY: 0.5,
    xCoordinates: [sourcePoint.x],
    yCoordinates: [sourcePoint.y],
    termination: { type: "boundary" },
    allowedLayers: ["inner2"],
    connections: [connection],
  }
  const connector = createBoundaryTerminalConnector({
    connectionName: "lane",
    edge: "bottom",
    layer: "inner2",
    exit: { x: 0.2628, y: -0.45 },
    bounds,
    approachLength: rules.traceWidth + rules.clearance,
  })
  const retained = [
    viaPoint,
    { x: 0.40824, y: 0.1596 },
    { x: 0.32696, y: 0.07832 },
    { x: 0.32696, y: -0.00296 },
    { x: 0.24568, y: -0.08424 },
    { x: 0.1644, y: -0.16552 },
  ]
  const entry = getBoundaryTerminalEntry(retained.at(-1)!, connector)!
  const plan = buildViaMinimalWindingPlan({
    ...rules,
    layerNames,
    bus,
    terminal: { connection, viaPoint, exitPoint: connector.exit },
    targetLayer: "inner2",
    targetLayerPoints: [...retained, ...entry.slice(1), connector.exit],
    allowBlindAndBuriedVias: false,
  })
  const splice = {
    rawSegments: plan.segments,
    firstEntrySegmentIndex: retained.length,
  }
  const original = structuredClone({ plan, splice, connector })
  expect(
    boundaryTerminalPlanIsSelfClear({
      plan,
      splice,
      clearance: rules.clearance,
      maximumJoinLength: 0,
    }),
  ).toBe(false)
  const params = {
    plans: [plan],
    splices: new Map([["lane", splice]]),
    connectors: new Map([["lane", connector]]),
    clearance: rules.clearance,
    segmentIsClear: () => true,
  }
  const repaired = repairBoundaryTerminalEntries(params)!
  expect(repaired).not.toBeNull()
  const candidate = repaired.plans[0]!
  expect(candidate.via).toEqual(plan.via)
  expect(candidate.additionalVias).toEqual(plan.additionalVias)
  expect(candidate.segments[0]).toEqual(plan.segments[0])
  expect(candidate.exitPoint).toEqual(plan.exitPoint)
  expect(repaired.splices.get("lane")!.firstEntrySegmentIndex).toBeLessThan(
    splice.firstEntrySegmentIndex,
  )
  const normalized = normalizeLayeredPath({
    points: candidate.trace.route.flatMap((p) =>
      p.route_type === "wire"
        ? [{ x: p.x, y: p.y, z: layerNames.indexOf(p.layer) }]
        : [],
    ),
    chamfer: rules.traceWidth / 4,
    segmentIsClear: () => true,
  })!
  expect(normalized).not.toBeNull()
  const final = createPlanWithSegments(
    candidate,
    normalized.slice(1).flatMap((end, i) => {
      const start = normalized[i]!
      return start.z === end.z
        ? [{ start, end, width: rules.traceWidth, layer: layerNames[start.z]! }]
        : []
    }),
  )!
  expect(final).not.toBeNull()
  expect(
    boundaryTerminalPlanIsSelfClear({
      plan: final,
      splice: repaired.splices.get("lane")!,
      clearance: rules.clearance,
      maximumJoinLength: rules.traceWidth / 4,
    }),
  ).toBe(true)
  for (const [i, s] of final.segments.entries()) {
    const dx = s.end.x - s.start.x,
      dy = s.end.y - s.start.y
    expect(
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ),
    ).toBeLessThan(1e-7)
    const next = final.segments[i + 1]
    if (next?.layer === s.layer)
      expect(
        (dx * (next.end.x - next.start.x) + dy * (next.end.y - next.start.y)) /
          (distance(s.start, s.end) * distance(next.start, next.end)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
  }
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: layerNames.length,
    minTraceWidth: rules.traceWidth,
    obstacles: [sourceObstacle],
    connections: [connection.connection],
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: [final],
    layerNames,
  })
  expect(
    validateFanoutSolution({
      ...rules,
      inputSrj,
      outputSrj,
      plans: [final],
      preparedBuses: [bus],
      sharedBoundary: bounds,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  const blockedPad = {
    ...sourceObstacle,
    center: connector.goal,
    layers: ["inner2"],
    connectedTo: ["foreign"],
  }
  expect(
    repairBoundaryTerminalEntries({
      ...params,
      segmentIsClear: (s) =>
        s.layer !== "inner2" ||
        distanceSegmentToObstacle(s, blockedPad) >=
          s.width / 2 + rules.clearance - 1e-9,
    }),
  ).toBeNull()
  expect({ plan, splice, connector }).toEqual(original)
  const graphics = visualizeSimpleRouteJson({ ...outputSrj, connections: [] })
  graphics.lines!.push({
    points: [retained.at(-2)!, ...entry],
    strokeColor: "#dc2626",
    strokeWidth: rules.traceWidth / 2,
  })
  expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
