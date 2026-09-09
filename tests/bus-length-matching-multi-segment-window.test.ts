import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("matches a declared pair through an exterior source-layer window across multiple segments", async () => {
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const bounds = { minX: -3, maxX: 8, minY: -1, maxY: 3 }
  const rules = {
    traceWidth: 0.05,
    clearance: 0.05,
    viaDiameter: 0.14,
    viaHoleDiameter: 0.07,
  }
  const pads: Obstacle[] = [
    { x: -0.3, y: 0 },
    { x: -2, y: 2 },
  ].map((center, i) => ({
    type: "rect",
    shape: "circle",
    center,
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`D${i}`],
  }))
  const connections: PreparedConnection[] = pads.map(
    (sourceObstacle, connectionIndex) => {
      const sourcePoint = {
        ...sourceObstacle.center,
        layer: "top",
        pointId: `P${connectionIndex}`,
      }
      const targetPoint = { x: 9, y: sourcePoint.y, layer: "bottom" }
      return {
        connection: {
          name: `D${connectionIndex}`,
          pointsToConnect: [sourcePoint, targetPoint],
        },
        connectionIndex,
        sourcePointIndex: 0,
        sourcePoint,
        sourceLayer: "top",
        sourceObstacle,
        targetPoint,
      }
    },
  )
  const bus: PreparedBus = {
    busId: "DATA",
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -2.04, maxX: -0.26, minY: -0.04, maxY: 2.04 },
    sharedBoundary: bounds,
    pitchX: 1.7,
    pitchY: 2,
    xCoordinates: [-2, -0.3],
    yCoordinates: [0, 2],
    termination: { type: "boundary" },
    allowedLayers: ["top", "bottom"],
    routableEscapeLayers: ["top", "bottom"],
    maxLengthSkew: 0.05,
    connections,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 4,
    bounds,
    minTraceWidth: rules.traceWidth,
    connections: connections.map((c) => c.connection),
    differentialPairs: [
      { connectionNames: ["D0", "D1"], lengthTolerance: 0.01 },
    ],
    obstacles: [
      ...pads,
      ...[-1, 1].flatMap((sign) =>
        [
          { x: 0.59, width: 0.78 },
          { x: 1.6, width: 0.76 },
          { x: 5.11, width: 5.78 },
        ].map(({ x, width }) => ({
          type: "rect" as const,
          center: { x, y: sign * 0.14 },
          width,
          height: 0.1,
          layers: ["bottom"],
          connectedTo: ["wall"],
        })),
      ),
    ],
  }
  const plans = connections.map((connection) => {
    const viaPoint = { x: 0, y: connection.sourcePoint.y },
      exitPoint = { x: 8, y: viaPoint.y }
    return buildViaMinimalWindingPlan({
      ...rules,
      layerNames,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints:
        connection.connectionIndex === 0
          ? [
              viaPoint,
              { x: 1.5, y: 0 },
              { x: 1.51, y: 0.01 },
              { x: 2.5, y: 0.01 },
              { x: 2.51, y: 0 },
              exitPoint,
            ]
          : [viaPoint, exitPoint],
      allowBlindAndBuriedVias: false,
    })
  })
  const original = structuredClone({ inputSrj, plans })
  const params = {
    ...rules,
    inputSrj,
    plans,
    preparedBuses: [bus],
    sharedBoundary: bounds,
    allowBlindAndBuriedVias: false,
    maximumWorkUnits: 20000,
    allowDistributedMatching: true,
    allowTransitLayerMatching: true,
    allowMatchingInsideDenseBounds: true,
  }
  expect(matchBusPlanLengths(params).plans === null).toBe(true)
  const result = matchBusPlanLengths({
    ...params,
    allowMultiSegmentTuningWindows: true,
  }).plans
  expect(result).not.toBeNull()
  if (!result) throw new Error("Expected both complete lanes to match")
  expect({ inputSrj, plans }).toEqual(original)
  expect(result[1]).toBe(plans[1])
  expect(result[0]!.via!.center).toEqual(plans[0]!.via!.center)
  expect(result[0]!.additionalVias).toHaveLength(2)
  expect(Math.abs(result[0]!.length - result[1]!.length)).toBeLessThanOrEqual(
    0.01,
  )
  expect(result[0]!.via).toEqual(plans[0]!.via)
  expect(
    result[0]!.trace.route
      .filter((p) => p.route_type === "via")
      .map((p) => [p.from_layer, p.to_layer]),
  ).toEqual([
    ["top", "bottom"],
    ["bottom", "top"],
    ["top", "bottom"],
  ])
  expect(result[0]!.targetLayer).toBe("bottom")
  expect(result[0]!.exitPoint).toEqual(plans[0]!.exitPoint)
  expect(result[0]!.segments[0]).toEqual(plans[0]!.segments[0])
  for (const plan of result) {
    for (const [i, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const previous = plan.segments[i - 1]
      if (previous?.layer === segment.layer) {
        const px = previous.end.x - previous.start.x,
          py = previous.end.y - previous.start.y
        expect(
          (px * dx + py * dy) / (Math.hypot(px, py) * Math.hypot(dx, dy)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
      }
    }
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: result,
    layerNames,
  })
  expect(
    validateFanoutSolution({ ...params, plans: result, outputSrj }).valid,
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    matchBusPlanLengths({
      ...params,
      allowMultiSegmentTuningWindows: true,
      preparedBuses: [
        { ...bus, allowedLayers: ["bottom"], routableEscapeLayers: ["bottom"] },
      ],
    }).plans,
  ).toBeNull()
  expect(
    matchBusPlanLengths({
      ...params,
      allowMultiSegmentTuningWindows: true,
      maximumWorkUnits: 0,
    }).plans,
  ).toBeNull()
  expect(
    matchBusPlanLengths({
      ...params,
      allowMultiSegmentTuningWindows: true,
      inputSrj: {
        ...inputSrj,
        obstacles: [
          ...inputSrj.obstacles,
          {
            type: "rect",
            center: { x: 1.1, y: 0 },
            width: 0.2,
            height: 0.2,
            layers: ["top"],
            connectedTo: ["future-pad"],
          },
        ],
      },
    }).plans,
  ).toBeNull()
  expect({ inputSrj, plans }).toEqual(original)
  expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...outputSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
  // Exercise the bounded matcher with and without via repair, then DRC and SVG.
  // Allow ARM CI runtime variance without changing the benchmark deadline.
}, 30_000)
