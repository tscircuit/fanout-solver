import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { distance } from "lib/geometry"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { fanoutPlansAreClear } from "lib/route-bus"
import type {
  Bounds,
  FanoutRoutePlan,
  PreparedBus,
  RoutedSegment,
} from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

const traceWidth = 0.08128
const clearance = 0.08128
const sharedBoundary: Bounds = {
  minX: -8.627,
  maxX: 8.627,
  minY: -8.627,
  maxY: 8.627,
}
// The pair is enclosed by a fixed guard and an unconstrained auxiliary lane.
// Moving the auxiliary lane opens the short member's only tuning window.
const fixtures = [
  {
    name: "AUXILIARY",
    points: [
      [-5, -3.5],
      [-5.25, -3.75],
      [-5.3125, -3.8125],
      [-5.3125, -7.4375],
      [-6.375, -8.5],
      [-6.375, -8.60018],
      [-6.40182, -8.627],
    ],
  },
  {
    name: "LONG",
    points: [
      [-5.5, -3],
      [-5.75, -3.25],
      [-5.6875, -3.1875],
      [-5.6875, -2.8125],
      [-5.375, -2.5],
      [-5.125, -2.5],
      [-4.8125, -2.8125],
      [-4.8125, -7.5625],
      [-5.75, -8.5],
      [-5.75, -8.61774],
      [-5.75926, -8.627],
    ],
  },
  {
    name: "SHORT",
    points: [
      [-5, -3],
      [-5.25, -2.75],
      [-5.25, -2.875],
      [-5, -3.125],
      [-5, -7.4375],
      [-6.0625, -8.5],
      [-6.0625, -8.60896],
      [-6.08054, -8.627],
    ],
  },
  {
    name: "GUARD",
    points: [
      [-5.5, -2.5],
      [-5.25, -2.25],
      [-5.125, -2.25],
      [-4.625, -2.75],
      [-4.625, -7.6875],
      [-5.4375, -8.5],
      [-5.4375, -8.62652],
      [-5.43798, -8.627],
    ],
  },
] as const

test("length matches a crowded pair by rerouting one unconstrained singleton", async () => {
  const obstacles: Obstacle[] = fixtures.map(({ name, points }) => ({
    obstacleId: `pad:${name}`,
    componentId: "component",
    type: "rect",
    shape: "circle",
    center: { x: points[0][0], y: points[0][1] },
    width: 0.254,
    height: 0.254,
    layers: ["top"],
    connectedTo: [`pad:${name}`, name],
  }))
  const connections = fixtures.map(({ name, points }) => ({
    name,
    pointsToConnect: [
      {
        x: points[0][0],
        y: points[0][1],
        layer: "top",
        pointId: `pad:${name}`,
        pcb_port_id: `pad:${name}`,
      },
      { x: points.at(-1)![0], y: -9, layer: "bottom" },
    ],
  }))
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    nominalTraceWidth: traceWidth,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.1,
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    defaultObstacleMargin: clearance,
    bounds: { ...sharedBoundary, minY: -10 },
    obstacles,
    connections,
  }
  const plans: FanoutRoutePlan[] = fixtures.map(
    ({ name, points }, connectionIndex) => {
      const path = points.map(([x, y]) => ({ x, y }))
      const segments: RoutedSegment[] = path.slice(1).map((end, index) => ({
        start: path[index]!,
        end,
        width: traceWidth,
        layer: index === 0 ? "top" : "bottom",
      }))
      return {
        busId: name === "LONG" || name === "SHORT" ? "PAIR" : name,
        connectionName: name,
        connectionIndex,
        sourcePointIndex: 0,
        sourcePoint: connections[connectionIndex]!.pointsToConnect[0]!,
        sourceObstacle: obstacles[connectionIndex]!,
        sourceLayer: "top",
        targetPoint: connections[connectionIndex]!.pointsToConnect[1]!,
        targetLayer: "bottom",
        termination: { type: "boundary" },
        direction: "left",
        exitEdge: "bottom",
        cornerBandSide: "minimum",
        exitPoint: path.at(-1)!,
        segments,
        via: {
          center: path[1]!,
          diameter: 0.24,
          holeDiameter: 0.1,
          fromLayer: "top",
          toLayer: "bottom",
          spanLayers: ["top", "bottom"],
        },
        length: segments.reduce(
          (total, segment) => total + distance(segment.start, segment.end),
          0,
        ),
        trace: {
          type: "pcb_trace",
          pcb_trace_id: `fanout:${name}`,
          connection_name: name,
          connectsTo: [`pad:${name}`, `exit:${name}`],
          route: [
            {
              route_type: "wire",
              ...path[0]!,
              layer: "top",
              width: traceWidth,
              start_pcb_port_id: `pad:${name}`,
            },
            {
              route_type: "wire",
              ...path[1]!,
              layer: "top",
              width: traceWidth,
            },
            {
              route_type: "via",
              ...path[1]!,
              from_layer: "top",
              to_layer: "bottom",
              via_diameter: 0.24,
              via_hole_diameter: 0.1,
            },
            ...path.slice(1).map((point, index) => ({
              route_type: "wire" as const,
              ...point,
              layer: "bottom",
              width: traceWidth,
              ...(index === path.length - 2
                ? { end_pcb_port_id: `exit:${name}` }
                : {}),
            })),
          ],
        },
      }
    },
  )
  const preparedBuses: PreparedBus[] = ["PAIR", "AUXILIARY"].map((busId) => ({
    busId,
    ...(busId === "PAIR" ? { maxLengthSkew: 0.25 } : {}),
    direction: "left",
    exitEdge: "bottom",
    preferredExit: "bottom-left",
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    componentId: "component",
    componentObstacles: obstacles,
    componentBounds: { minX: -6.752, maxX: 6.752, minY: -6.752, maxY: 6.752 },
    sharedBoundary,
    xCoordinates: [-5.5, -5],
    yCoordinates: [-3.5, -3, -2.5],
    pitchX: 0.5,
    pitchY: 0.5,
    connections: plans
      .filter((plan) => plan.busId === busId)
      .map((plan) => ({
        connection: connections[plan.connectionIndex]!,
        connectionIndex: plan.connectionIndex,
        sourcePointIndex: 0,
        sourcePoint: plan.sourcePoint,
        sourceLayer: "top",
        sourceObstacle: plan.sourceObstacle,
        targetPoint: plan.targetPoint,
      })),
  }))
  const options = {
    plans,
    preparedBuses,
    inputSrj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias: false,
    allowMatchingInsideDenseBounds: true,
    allowPairLaneSpreading: true,
  }
  expect(fanoutPlansAreClear({ ...options, srj: inputSrj })).toBe(true)
  expect(matchBusPlanLengths(options).plans).toBeNull()
  const result = matchBusPlanLengths({
    ...options,
    allowUnconstrainedLaneRerouting: true,
  })
  expect(result.plans).not.toBeNull()
  if (!result.plans) throw new Error("Expected singleton repair")
  const pair = result.plans.filter((plan) => plan.busId === "PAIR")
  expect(
    Math.max(...pair.map((plan) => plan.length)) -
      Math.min(...pair.map((plan) => plan.length)),
  ).toBeLessThanOrEqual(0.250001)
  for (const [index, matched] of result.plans.entries()) {
    const original = plans[index]!
    expect(matched.sourcePoint).toEqual(original.sourcePoint)
    expect(matched.segments[0]).toEqual(original.segments[0])
    expect(matched.via).toEqual(original.via)
    expect(matched.additionalVias).toBeUndefined()
    expect(matched.targetLayer).toBe(original.targetLayer)
    expect(matched.exitPoint).toEqual(original.exitPoint)
    expect(matched.trace.pcb_trace_id).toBe(original.trace.pcb_trace_id)
    expect(matched.trace.route[0]).toEqual(original.trace.route[0])
    expect(matched.trace.route.at(-1)).toEqual(original.trace.route.at(-1))
    if (
      original.connectionName === "GUARD" ||
      original.connectionName === "LONG"
    )
      expect(matched).toBe(original)
    else expect(matched.segments).not.toEqual(original.segments)
  }
  expect(
    matchBusPlanLengths({
      ...options,
      allowUnconstrainedLaneRerouting: true,
      candidatePlansAreFeasible: () => false,
    }).plans,
  ).toBeNull()
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: result.plans,
    layerNames: ["top", "bottom"],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 4,
    checkedViaCount: 4,
    issues: [],
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...inputSrj,
        connections: [],
        traces: result.plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
