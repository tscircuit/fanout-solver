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

test("rejects a tuning via that would short a retained source prefix through another layer", () => {
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const bounds = { minX: -6, maxX: 8, minY: -1, maxY: 3 }
  const rules = {
    traceWidth: 0.05,
    clearance: 0.05,
    viaDiameter: 0.14,
    viaHoleDiameter: 0.07,
  }
  const pads: Obstacle[] = [
    { x: 2, y: -0.6 },
    { x: -5.2, y: 2 },
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
      const targetPoint = { x: 9, y: connectionIndex * 2, layer: "bottom" }
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
    componentBounds: { minX: -5.24, maxX: 2.04, minY: -0.64, maxY: 2.04 },
    sharedBoundary: bounds,
    pitchX: 7.2,
    pitchY: 2.6,
    xCoordinates: [-5.2, 2],
    yCoordinates: [-0.6, 2],
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
  const plans = connections.map((connection, index) => {
    const viaPoint = { x: 0, y: index * 2 }
    const exitPoint = { x: 8, y: viaPoint.y }
    return buildViaMinimalWindingPlan({
      ...rules,
      layerNames,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints: [viaPoint, exitPoint],
      sourceEscapePoints: index
        ? undefined
        : [
            connection.sourcePoint,
            { x: 2, y: 0.4 },
            { x: 1.6, y: 0.8 },
            { x: 0.8, y: 0.8 },
            viaPoint,
          ],
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
  // The only clear barrel site through the bottom walls is x=2, y=0.
  // Its center is on D0's retained TOP prefix, away from its actual first via.
  // Same-net native DRC alone cannot detect the resulting electrical shortcut.
  expect(matchBusPlanLengths(params).plans).toBeNull()
  expect(
    matchBusPlanLengths({ ...params, allowAdditionalMatchingVias: true }).plans,
  ).toBeNull()
  const outputSrj = buildOutputSimpleRouteJson({ inputSrj, plans, layerNames })
  expect(
    validateFanoutSolution({ ...params, outputSrj }).issues.map((i) => i.code),
  ).toEqual(["bus-length-skew"])
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    issues: [],
    checkedTraceCount: 2,
    checkedViaCount: 2,
  })
  for (const plan of plans) {
    for (const [index, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-8)
      const previous = plan.segments[index - 1]
      if (previous?.layer === segment.layer) {
        const px = previous.end.x - previous.start.x,
          py = previous.end.y - previous.start.y
        expect(
          (px * dx + py * dy) / Math.hypot(px, py) / Math.hypot(dx, dy),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-8)
      }
    }
  }
  expect({ inputSrj, plans }).toEqual(original)
  expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...outputSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
