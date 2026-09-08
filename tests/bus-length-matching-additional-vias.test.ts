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

test("opens a permitted transit tuning window with a clear through via and preserves both complete lanes", async () => {
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
    allowedLayers: ["inner1", "bottom"],
    routableEscapeLayers: ["inner1", "bottom"],
    maxLengthSkew: 0.05,
    connections,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 4,
    bounds,
    minTraceWidth: rules.traceWidth,
    connections: connections.map((c) => c.connection),
    obstacles: [
      ...pads,
      ...[-1, 1].flatMap((sign) =>
        [
          { x: 1.03875, width: 1.6775 },
          { x: 5.06125, width: 5.8775 },
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
      targetLayerPoints: [viaPoint, exitPoint],
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
  expect(matchBusPlanLengths(params).plans).toBeNull()
  const result = matchBusPlanLengths({
    ...params,
    allowAdditionalMatchingVias: true,
  }).plans
  expect(result).not.toBeNull()
  if (!result) throw new Error("Expected both complete lanes to match")
  expect({ inputSrj, plans }).toEqual(original)
  expect(result[1]).toBe(plans[1])
  expect(result[0]!.via!.center).toEqual(plans[0]!.via!.center)
  expect(result[0]!.additionalVias!.length).toBeGreaterThan(0)
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
      allowAdditionalMatchingVias: true,
      preparedBuses: [
        { ...bus, allowedLayers: ["bottom"], routableEscapeLayers: ["bottom"] },
      ],
    }).plans,
  ).toBeNull()
  expect(
    matchBusPlanLengths({
      ...params,
      allowAdditionalMatchingVias: true,
      maximumWorkUnits: 0,
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
