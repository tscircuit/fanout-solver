import { expect, test } from "bun:test"
import "bun-match-svg"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import {
  getCornerTargetTrack,
  routeBusAlternativesSteps,
} from "../lib/route-bus"
import { routeNarrowWindingPreflightSteps } from "../lib/route-narrow-winding-preflight"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

function finish<T>(steps: Generator<unknown, T, void>): T {
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

test("routes a fixed-via pair into a free edge gap with bounded ordered winding", async () => {
  const boundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const layerNames = ["top", "inner1", "bottom"]
  const width = 0.1
  const clearance = 0.1
  // The pair's input order is opposite its border order.
  const definitions = [
    { name: "PAIR_P", x: 0, y: 0.25, targetY: 4 },
    { name: "PAIR_N", x: 0, y: -0.4, targetY: 3 },
    { name: "SINGLE", x: -1, y: -1, targetY: -1.5 },
    { name: "ACCEPTED", x: 4.7, y: 1.4, targetY: 1.4 },
  ]
  const pads = definitions.map(({ name, x, y }, index) => ({
    type: "rect" as const,
    center: { x, y },
    width: index === 3 ? 0.6 : 0.3,
    height: 0.3,
    layers: [index === 3 ? "inner1" : "top"],
    componentId: index === 3 ? "U2" : "U1",
    connectedTo: [name],
  }))
  const connections = definitions.map(({ name, targetY }, index) => ({
    name,
    pointsToConnect: [
      {
        ...pads[index]!.center,
        layer: pads[index]!.layers[0]!,
        pointId: `source-${index}`,
      },
      { x: -6, y: targetY, layer: "inner1", pointId: `target-${index}` },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: layerNames.length,
    minTraceWidth: width,
    bounds: boundary,
    obstacles: pads,
    connections,
  }
  const prepared: PreparedConnection[] = connections.map(
    (connection, index) => ({
      connection,
      connectionIndex: index,
      sourcePointIndex: 0,
      sourcePoint: connection.pointsToConnect[0]!,
      sourceLayer: pads[index]!.layers[0]!,
      sourceObstacle: pads[index]!,
      targetPoint: connection.pointsToConnect[1]!,
      exitTargetPoint: connection.pointsToConnect[1]!,
      hasExplicitExitTarget: true,
      hasExplicitLayeredExitTarget: true,
    }),
  )
  const buses: PreparedBus[] = [[0, 1], [2], [3]].map((indices, index) => ({
    busId: ["PAIR", "SINGLE", "ACCEPTED"][index]!,
    componentId: index === 2 ? "U2" : "U1",
    componentObstacles: index === 2 ? [pads[3]!] : pads.slice(0, 3),
    componentBounds:
      index === 2
        ? { minX: 4.4, maxX: 5, minY: 1.25, maxY: 1.55 }
        : { minX: -1.15, maxX: 0.15, minY: -1.15, maxY: 0.4 },
    sharedBoundary: boundary,
    xCoordinates: index === 2 ? [4.7] : [-1, 0],
    yCoordinates: index === 2 ? [1.4] : [-1, -0.4, 0.25],
    pitchX: 1,
    pitchY: 0.65,
    direction: index === 0 ? "up" : "left",
    exitEdge: "left",
    preferredExit: index === 0 ? "top-left" : "left",
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    termination: { type: "boundary" },
    connections: indices.map((index) => prepared[index]!),
  }))
  // The accepted trace and its pad form a wall across the entire target layer.
  const accepted: FanoutRoutePlan = {
    ...prepared[3]!,
    busId: "ACCEPTED",
    connectionName: "ACCEPTED",
    targetLayer: "inner1",
    direction: "left",
    exitEdge: "left",
    termination: { type: "boundary" },
    exitPoint: { x: -5, y: 1.4 },
    length: 9.7,
    segments: [
      {
        start: pads[3]!.center,
        end: { x: -5, y: 1.4 },
        layer: "inner1",
        width,
      },
    ],
    trace: {
      type: "pcb_trace",
      pcb_trace_id: "accepted-trace",
      connection_name: "ACCEPTED",
      route: [pads[3]!.center, { x: -5, y: 1.4 }].map((point) => ({
        route_type: "wire" as const,
        ...point,
        layer: "inner1",
        width,
      })),
    },
  }
  const vias = new Map(
    prepared.slice(0, 3).map((connection) => [
      connection.connectionIndex,
      {
        x: connection.sourcePoint.x + 0.3,
        y: connection.sourcePoint.y + 0.3,
      },
    ]),
  )
  const sourcePaths = new Map(
    prepared
      .slice(0, 3)
      .map((connection) => [
        connection.connectionIndex,
        [connection.sourcePoint, vias.get(connection.connectionIndex)!],
      ]),
  )
  const params = {
    srj,
    targetLayer: "inner1",
    acceptedPlans: [accepted],
    layerNames,
    traceWidth: width,
    clearance,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    compactBusTracks: false,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    fixedViaPointsByConnectionIndex: vias,
    sourceEscapePaths: sourcePaths,
    reservedVias: prepared.slice(0, 3).map((connection) => ({
      connectionName: connection.connection.name,
      via: {
        center: vias.get(connection.connectionIndex)!,
        diameter: 0.3,
        holeDiameter: 0.15,
        fromLayer: "top",
        toLayer: "inner1",
        spanLayers: layerNames,
      },
    })),
  }
  const pair = buses[0]!
  expect(
    finish(
      routeBusAlternativesSteps(
        {
          ...params,
          bus: pair,
          reservedVias: params.reservedVias.slice(2),
          viaMinimalOnly: true,
          adaptiveWindingRouteOrder: true,
          alignWindingGridToPads: true,
          windingGridStep: 0.1,
          fixedViaFallbackRouteOrderAttempts: 32,
        },
        1,
        false,
      ),
    ),
  ).toEqual([])
  const sourcePlans = buses.slice(0, 2).flatMap((bus) =>
    bus.connections.map((connection) => {
      const viaPoint = vias.get(connection.connectionIndex)!
      return buildViaMinimalWindingPlan({
        ...params,
        bus,
        terminal: { connection, viaPoint, exitPoint: viaPoint },
        sourceEscapePoints: sourcePaths.get(connection.connectionIndex)!,
        targetLayerPoints: [viaPoint, viaPoint],
      })
    }),
  )
  const before = JSON.stringify({ params, sourcePlans })
  const recovered = finish(
    routeNarrowWindingPreflightSteps({
      ...params,
      sourcePlans,
      buses: buses.slice(0, 2),
    }),
  )
  expect(JSON.stringify({ params, sourcePlans })).toBe(before)
  expect(recovered).toHaveLength(3)
  expect(recovered![0]!.busId).toBe("PAIR")
  const pairPlans = recovered!
    .filter((plan) => plan.busId === "PAIR")
    .sort((a, b) => a.connectionIndex - b.connectionIndex)
  expect(pairPlans).toHaveLength(2)
  const reference = pair.connections.map((connection) =>
    getCornerTargetTrack({
      ...params,
      bus: pair,
      connection,
      cornerExitLaneOffset: 0,
      windingOrderIndex: 0,
    }),
  )
  expect(pairPlans[0]!.exitPoint.y).toBeGreaterThan(pairPlans[1]!.exitPoint.y)
  expect(pairPlans[0]!.exitPoint.y - pairPlans[1]!.exitPoint.y).toBeCloseTo(
    reference[0]! - reference[1]!,
    8,
  )
  for (const plan of recovered!) {
    const connection = prepared[plan.connectionIndex]!
    const path = sourcePaths.get(plan.connectionIndex)!
    expect(plan.sourceObstacle).toBe(connection.sourceObstacle)
    expect(plan.targetPoint).toEqual(connection.targetPoint)
    expect(plan.via!.center).toEqual(vias.get(plan.connectionIndex)!)
    expect(plan.via!.spanLayers).toEqual(layerNames)
    expect(plan.additionalVias ?? []).toHaveLength(0)
    expect(plan.segments[0]).toEqual({
      start: path[0],
      end: path[1],
      layer: "top",
      width,
    })
    expect(plan.exitPoint.x).toBe(-5)
    for (const [i, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x
      const dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const previous = plan.segments[i - 1]
      if (!previous || previous.layer !== segment.layer) continue
      const px = previous.end.x - previous.start.x
      const py = previous.end.y - previous.start.y
      const lengths = Math.hypot(dx, dy) * Math.hypot(px, py)
      if (lengths > 1e-12)
        expect((dx * px + dy * py) / lengths).toBeGreaterThanOrEqual(
          Math.SQRT1_2 - 1e-7,
        )
    }
    if (plan.busId === "PAIR") {
      expect(plan.cornerBandSide).toBe("maximum")
      expect(plan.direction).toBe("up")
      expect(plan.exitPoint.y).toBeGreaterThan(width / 2)
      expect(plan.exitPoint.y).toBeLessThan(1.4 - width - clearance)
    } else {
      expect(plan.cornerBandSide).toBeUndefined()
      expect(plan.exitPoint.y).toBeLessThan(0)
    }
  }
  const plans = [...recovered!, accepted]
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: buses,
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 4,
    brokenOutConnectionCount: 4,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const graphics = visualizeSimpleRouteJson({ ...output, connections: [] })
  graphics.lines!.unshift(
    {
      points: [
        { x: -5, y: 0 },
        { x: -5, y: 3 },
      ],
      strokeColor: "#86b697",
      strokeWidth: 0.035,
    },
    {
      points: [
        { x: -5, y: -2 },
        { x: -5, y: 0 },
      ],
      strokeColor: "#b0b0b0",
      strokeWidth: 0.035,
    },
    {
      points: [
        { x: -5, y: 0 },
        { x: 1, y: 0 },
      ],
      strokeColor: "#a0a0a0",
      strokeWidth: 0.025,
      strokeDash: [0.1, 0.1],
    },
  )
  graphics.texts = [
    {
      x: -2.5,
      y: 2.5,
      text: "Blocked pair corner tracks",
      fontSize: 0.22,
      color: "#dc2626",
    },
    {
      x: -1,
      y: 1.8,
      text: "Accepted copper",
      fontSize: 0.22,
      color: "#2563eb",
    },
    { x: -3, y: 0.3, text: "Ordered pair", fontSize: 0.18, color: "#2563eb" },
    {
      x: -3,
      y: -1.7,
      text: "Plain-edge singleton",
      fontSize: 0.22,
      color: "#2563eb",
    },
  ]
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
