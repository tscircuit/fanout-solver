import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { distance } from "lib/geometry"
import {
  matchBusPlanLengths,
  replacementCopperIsSelfClear,
} from "lib/match-bus-lengths"
import { fanoutPlansAreClear } from "lib/route-bus"
import type {
  Bounds,
  FanoutRoutePlan,
  PreparedBus,
  RoutedSegment,
} from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

const traceWidth = 0.08128
const clearance = 0.08128
const sharedBoundary: Bounds = { minX: -2, maxX: 4, minY: -2, maxY: 4.5 }
const stair: number[][] = [[2, 0]]
for (let i = 0; i < 12; i++) {
  const x = 2 + i * 0.08128,
    y = i * 0.08128
  stair.push(
    [x + 0.02032, y + 0.02032],
    [x + 0.06096, y + 0.02032],
    [x + 0.08128, y + 0.04064],
    [x + 0.08128, y + 0.08128],
  )
}
const fixtures = [
  { name: "SHORT", points: [[-1, 0], [0, 0], ...stair, [4, 0.97536]] },
  {
    name: "LONG",
    points: [
      [-1, 2],
      [0, 2],
      [0, 3],
      [0.5, 3.5],
      [4, 3.5],
    ],
  },
]

test("retains an unchanged lead beside a chamfered continuation while checking new meander copper", async () => {
  const obstacles: Obstacle[] = fixtures.map(({ name, points }) => ({
    obstacleId: `pad:${name}`,
    componentId: "component",
    type: "rect",
    shape: "circle",
    center: { x: points[0]![0]!, y: points[0]![1]! },
    width: 0.254,
    height: 0.254,
    layers: ["top"],
    connectedTo: [`pad:${name}`, name],
  }))
  const connections = fixtures.map(({ name, points }) => ({
    name,
    pointsToConnect: [
      {
        x: points[0]![0]!,
        y: points[0]![1]!,
        layer: "top",
        pointId: `pad:${name}`,
        pcb_port_id: `pad:${name}`,
      },
      { x: 6, y: points.at(-1)![1]!, layer: "bottom" },
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
    bounds: { ...sharedBoundary, maxX: 7 },
    obstacles,
    connections,
  }
  const plans: FanoutRoutePlan[] = fixtures.map(
    ({ name, points }, connectionIndex) => {
      const path = points.map(([x, y]) => ({ x: x!, y: y! }))
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
        direction: "right",
        exitEdge: "right",
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
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
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
  const before = structuredClone(plans)
  const result = matchBusPlanLengths(options)
  expect(result.plans).not.toBeNull()
  if (!result.plans)
    throw new Error("Expected a clear meander before the retained staircase")
  expect(plans).toEqual(before)
  expect(
    Math.abs(result.plans[0]!.length - result.plans[1]!.length),
  ).toBeLessThanOrEqual(0.250001)
  expect(result.plans[1]).toBe(plans[1])
  for (const [index, matched] of result.plans.entries()) {
    expect(matched.via).toEqual(plans[index]!.via)
    expect(matched.segments[0]).toEqual(plans[index]!.segments[0])
    expect(matched.trace.route[0]).toEqual(plans[index]!.trace.route[0])
    expect(matched.trace.route.at(-1)).toEqual(plans[index]!.trace.route.at(-1))
  }
  // A new detour reaching the retained staircase still fails the same guard.
  const plan = plans[0]!,
    segmentIndex = 1,
    original = plan.segments[segmentIndex]!
  const collisionPoints = [
    original.start,
    { x: 1.5, y: 0 },
    { x: 1.6, y: 0.1 },
    { x: 1.6, y: 0.5 },
    { x: 1.7, y: 0.6 },
    { x: 2.4, y: 0.6 },
    { x: 2.5, y: 0.5 },
    { x: 2.5, y: 0.3 },
    { x: 2.4, y: 0.2 },
    { x: 2.2, y: 0.2 },
    original.end,
  ]
  const replacement = collisionPoints
    .slice(1)
    .map((end, index) => ({ ...original, start: collisionPoints[index]!, end }))
  expect(
    replacementCopperIsSelfClear({
      plan,
      segments: [
        ...plan.segments.slice(0, segmentIndex),
        ...replacement,
        ...plan.segments.slice(segmentIndex + 1),
      ],
      replacementStartIndex: segmentIndex,
      replacementSegmentCount: replacement.length,
      clearance,
    }),
  ).toBe(false)
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
  const graphics = {
    lines: [],
    circles: [],
    texts: [],
  } as import("graphics-debug").GraphicsObject
  for (const [index, matched] of result.plans.entries()) {
    for (const segment of matched.segments)
      graphics.lines!.push({
        points: [segment.start, segment.end],
        strokeColor: ["#2563eb", "#e57d19"][index],
        strokeWidth: segment.width,
      })
    graphics.circles!.push({
      center: matched.via!.center,
      radius: matched.via!.diameter / 2,
      fill: "#334155",
    })
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
