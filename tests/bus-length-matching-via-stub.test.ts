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
const sharedBoundary: Bounds = { minX: -3, maxX: 3, minY: -6, maxY: 4 }
// The tiny diagonal stub joins an off-grid via to the long target-layer run.
const fixtures = [
  {
    name: "SHORT",
    points: [
      [-1, 0],
      [0, 0],
      [0.002, -0.002],
      [0.002, -6],
    ],
  },
  {
    name: "LONG",
    points: [
      [-1, 2],
      [0, 2],
      [1, 1],
      [1, -6],
    ],
  },
] as const

test("length matches a lane connected to its via through a short grid stub", async () => {
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
  const preparedBuses: PreparedBus[] = ["PAIR"].map((busId) => ({
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
    componentBounds: { minX: -1.127, maxX: -0.873, minY: -0.127, maxY: 2.127 },
    sharedBoundary,
    xCoordinates: [-1],
    yCoordinates: [0, 2],
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
  }
  expect(fanoutPlansAreClear({ ...options, srj: inputSrj })).toBe(true)
  const result = matchBusPlanLengths(options)
  expect(result.plans).not.toBeNull()
  if (!result.plans)
    throw new Error("Expected matching through the connected via stub")
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
    if (original.connectionName === "LONG") expect(matched).toBe(original)
    else expect(matched.segments).not.toEqual(original.segments)
  }
  expect(
    matchBusPlanLengths({
      ...options,
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
    checkedTraceCount: 2,
    checkedViaCount: 2,
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
}, 30_000)
