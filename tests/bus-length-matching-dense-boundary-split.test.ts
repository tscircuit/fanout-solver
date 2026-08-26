import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { distance } from "lib/geometry"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

const traceWidth = 0.1
const clearance = 0.1
const viaDiameter = 0.3
const viaHoleDiameter = 0.15
const sharedBoundary: Bounds = {
  minX: -3,
  maxX: 6,
  minY: -4,
  maxY: 8,
}

function createBoundaryPlan(params: {
  name: string
  connectionIndex: number
  source: Point2D
  via: Point2D
  exit: Point2D
  sourceObstacle: Obstacle
  connection: SimpleRouteConnection
}): FanoutRoutePlan {
  const {
    name,
    connectionIndex,
    source,
    via,
    exit,
    sourceObstacle,
    connection,
  } = params
  const segments: RoutedSegment[] = [
    { start: source, end: via, width: traceWidth, layer: "top" },
    { start: via, end: exit, width: traceWidth, layer: "bottom" },
  ]
  return {
    busId: "DIAGONAL_BUS",
    connectionName: name,
    connectionIndex,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceObstacle,
    sourceLayer: "top",
    targetPoint: connection.pointsToConnect[1]!,
    targetLayer: "bottom",
    termination: { type: "boundary" },
    direction: "right",
    exitEdge: "right",
    exitPoint: exit,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: `fanout:${name}`,
      connection_name: name,
      connectsTo: [sourceObstacle.obstacleId!, name],
      route: [
        {
          route_type: "wire",
          ...source,
          width: traceWidth,
          layer: "top",
        },
        {
          route_type: "wire",
          ...via,
          width: traceWidth,
          layer: "top",
        },
        {
          route_type: "via",
          ...via,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: viaDiameter,
          via_hole_diameter: viaHoleDiameter,
        },
        {
          route_type: "wire",
          ...via,
          width: traceWidth,
          layer: "bottom",
        },
        {
          route_type: "wire",
          ...exit,
          width: traceWidth,
          layer: "bottom",
        },
      ],
    },
    segments,
    via: {
      center: via,
      diameter: viaDiameter,
      holeDiameter: viaHoleDiameter,
      fromLayer: "top",
      toLayer: "bottom",
      spanLayers: ["top", "bottom"],
    },
    length: segments.reduce(
      (total, segment) => total + distance(segment.start, segment.end),
      0,
    ),
  }
}

test("length matches the outside portion of a 45-degree dense-boundary crossing", () => {
  const names = ["SHORT", "LONG"] as const
  const sources = [
    { x: -0.5, y: 0 },
    { x: -1.5, y: -2 },
  ] as const
  const vias = [
    { x: 0, y: 0 },
    { x: 0, y: -2 },
  ] as const
  const exits = [
    { x: 6, y: 6 },
    { x: 6, y: 4 },
  ] as const
  const sourceObstacles: Obstacle[] = sources.map((center, index) => ({
    obstacleId: `pad:${names[index]}`,
    componentId: "source-component",
    type: "rect",
    center,
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: [`pad:${names[index]}`, names[index]!],
  }))
  // This top-layer pad extends the dense component envelope to 3.5 mm. The
  // target-layer diagonal therefore crosses the expanded 3.65 mm boundary.
  const denseMarker: Obstacle = {
    obstacleId: "pad:dense-marker",
    componentId: "source-component",
    type: "rect",
    center: { x: 3.4, y: 3.4 },
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: ["pad:dense-marker"],
  }
  // These tiny keepouts leave a clear tuning window immediately outside the
  // dense boundary while ruling out the whole-segment placement samples.
  const tuningWindowKeepouts: Obstacle[] = [
    { x: 5.719929928335535, y: 6.067938037308499 },
    { x: 4.548172486799348, y: 4.314295246167759 },
    { x: 4.169669560556699, y: 4.794975100383973 },
  ].map((center, index) => ({
    obstacleId: `tuning-window-keepout:${index}`,
    componentId: "other-component",
    type: "rect",
    center,
    width: 0.01,
    height: 0.01,
    layers: ["bottom"],
    connectedTo: [`tuning-window-keepout:${index}`],
  }))
  const connections: SimpleRouteConnection[] = names.map((name, index) => ({
    name,
    pointsToConnect: [
      {
        ...sources[index]!,
        layer: "top",
        pointId: `pad:${name}`,
      },
      { x: 8, y: exits[index]!.y, layer: "bottom" },
    ],
  }))
  const preparedConnections: PreparedConnection[] = names.map(
    (_name, connectionIndex) => ({
      connection: connections[connectionIndex]!,
      connectionIndex,
      sourcePoint: connections[connectionIndex]!.pointsToConnect[0]!,
      sourcePointIndex: 0,
      sourceLayer: "top",
      sourceObstacle: sourceObstacles[connectionIndex]!,
      targetPoint: connections[connectionIndex]!.pointsToConnect[1]!,
    }),
  )
  const preparedBus: PreparedBus = {
    busId: "DIAGONAL_BUS",
    maxLengthSkew: 0.25,
    direction: "right",
    exitEdge: "right",
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    termination: { type: "boundary" },
    connections: preparedConnections,
    componentId: "source-component",
    componentObstacles: [...sourceObstacles, denseMarker],
    componentBounds: {
      minX: -1.6,
      maxX: 3.5,
      minY: -2.1,
      maxY: 3.5,
    },
    sharedBoundary,
    xCoordinates: [-1.5, -0.5, 3.4],
    yCoordinates: [-2, 0, 3.4],
    pitchX: 1,
    pitchY: 1,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    nominalTraceWidth: traceWidth,
    minViaPadDiameter: viaDiameter,
    minViaHoleDiameter: viaHoleDiameter,
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    defaultObstacleMargin: clearance,
    bounds: { minX: -3, maxX: 9, minY: -4, maxY: 8 },
    obstacles: [...sourceObstacles, denseMarker, ...tuningWindowKeepouts],
    connections,
    buses: [
      {
        busId: "DIAGONAL_BUS",
        connectionNames: [...names],
        maxLengthSkew: 0.25,
      },
    ],
  }
  const baselinePlans = names.map((name, connectionIndex) =>
    createBoundaryPlan({
      name,
      connectionIndex,
      source: sources[connectionIndex]!,
      via: vias[connectionIndex]!,
      exit: exits[connectionIndex]!,
      sourceObstacle: sourceObstacles[connectionIndex]!,
      connection: connections[connectionIndex]!,
    }),
  )

  const result = matchBusPlanLengths({
    plans: baselinePlans,
    preparedBuses: [preparedBus],
    inputSrj,
    sharedBoundary,
    clearance,
  })
  expect(result.plans).not.toBeNull()
  if (!result.plans) throw new Error("Expected dense-boundary length matching")

  const matchedPlans = result.plans
  const matchedShort = matchedPlans.find(
    (plan) => plan.connectionName === "SHORT",
  )!
  expect(matchedShort.length).toBeGreaterThan(baselinePlans[0]!.length)
  const lengths = matchedPlans.map((plan) => plan.length)
  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(
    0.250001,
  )

  for (const [planIndex, matchedPlan] of matchedPlans.entries()) {
    const baselinePlan = baselinePlans[planIndex]!
    expect(matchedPlan.sourcePoint).toEqual(baselinePlan.sourcePoint)
    expect(matchedPlan.exitPoint).toEqual(baselinePlan.exitPoint)
    expect([matchedPlan.via, ...(matchedPlan.additionalVias ?? [])]).toEqual([
      baselinePlan.via,
    ])
  }

  const expandedDenseMaximum =
    denseMarker.center.x + denseMarker.width / 2 + traceWidth / 2 + clearance
  const matchedTargetSegments = matchedShort.segments.filter(
    (segment) => segment.layer === "bottom",
  )
  expect(matchedTargetSegments[0]).toMatchObject({
    start: vias[0],
    width: traceWidth,
    layer: "bottom",
  })
  expect(matchedTargetSegments[0]!.end.x).toBeCloseTo(expandedDenseMaximum, 12)
  expect(matchedTargetSegments[0]!.end.y).toBeCloseTo(expandedDenseMaximum, 12)
  const meanderPoints = matchedTargetSegments
    .slice(1)
    .flatMap((segment) => [segment.start, segment.end])
    .filter(
      (point) =>
        distance(point, { x: expandedDenseMaximum, y: expandedDenseMaximum }) >
          1e-6 && distance(point, exits[0]) > 1e-6,
    )
  expect(
    meanderPoints.some((point) => Math.abs(point.x - point.y) > 1e-6),
  ).toBe(true)
  for (const point of meanderPoints) {
    expect(
      point.x > expandedDenseMaximum || point.y > expandedDenseMaximum,
    ).toBe(true)
  }

  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: matchedPlans,
    layerNames: ["top", "bottom"],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance,
    }),
  ).toEqual({
    valid: true,
    checkedTraceCount: 2,
    checkedSegmentCount: 13,
    checkedViaCount: 2,
    issues: [],
  })
})
