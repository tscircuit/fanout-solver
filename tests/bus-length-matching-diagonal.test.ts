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
import { validateFanoutSolution } from "lib/validate-fanout-solution"

const sharedBoundary: Bounds = {
  minX: -2,
  maxX: 6,
  minY: -5,
  maxY: 6,
}
const traceWidth = 0.1
const clearance = 0.1

interface DiagonalConnectionFixture {
  name: string
  source: Point2D
  via: Point2D
  exit: Point2D
  target: Point2D
}

function createDiagonalPlan(params: {
  fixture: DiagonalConnectionFixture
  connection: SimpleRouteConnection
  connectionIndex: number
  sourceObstacle: Obstacle
}): FanoutRoutePlan {
  const { fixture, connection, connectionIndex, sourceObstacle } = params
  const sourceEndpoint = connection.pointsToConnect[0]!
  const sourceSegment: RoutedSegment = {
    start: fixture.source,
    end: fixture.via,
    width: traceWidth,
    layer: "top",
  }
  const targetSegment: RoutedSegment = {
    start: fixture.via,
    end: fixture.exit,
    width: traceWidth,
    layer: "bottom",
  }
  const hasSourceDogbone = distance(fixture.source, fixture.via) > 1e-6
  const segments = [...(hasSourceDogbone ? [sourceSegment] : []), targetSegment]
  return {
    busId: "DIAGONAL_BUS",
    connectionName: fixture.name,
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
    exitPoint: fixture.exit,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: `fanout:${fixture.name}`,
      connection_name: fixture.name,
      connectsTo: [
        sourceObstacle.obstacleId!,
        sourceEndpoint.pcb_port_id!,
        `exit:${fixture.name}`,
      ],
      route: [
        {
          route_type: "wire",
          ...fixture.source,
          width: traceWidth,
          layer: "top",
          start_pcb_port_id: sourceEndpoint.pcb_port_id,
        },
        ...(hasSourceDogbone
          ? [
              {
                route_type: "wire" as const,
                ...fixture.via,
                width: traceWidth,
                layer: "top",
              },
            ]
          : []),
        {
          route_type: "via",
          ...fixture.via,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        {
          route_type: "wire",
          ...fixture.via,
          width: traceWidth,
          layer: "bottom",
        },
        {
          route_type: "wire",
          ...fixture.exit,
          width: traceWidth,
          layer: "bottom",
          end_pcb_port_id: `boundary-port:${fixture.name}`,
        },
      ],
    },
    segments,
    via: {
      center: fixture.via,
      diameter: 0.3,
      holeDiameter: 0.15,
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

test("matches a diagonal bus without losing tuned via-in-pad endpoint metadata", () => {
  const fixtures: DiagonalConnectionFixture[] = [
    {
      name: "SHORT",
      source: { x: 1, y: 0 },
      via: { x: 1, y: 0 },
      exit: { x: 6, y: 5 },
      target: { x: 8, y: 7 },
    },
    {
      name: "LONG",
      source: { x: -1, y: -4 },
      via: { x: 0, y: -3 },
      exit: { x: 6, y: 3 },
      target: { x: 8, y: 5 },
    },
  ]
  const sourceObstacles: Obstacle[] = fixtures.map((fixture) => ({
    obstacleId: `pad:${fixture.name}`,
    componentId: "source-component",
    type: "rect",
    center: fixture.source,
    width: fixture.name === "SHORT" ? 0.4 : 0.2,
    height: fixture.name === "SHORT" ? 0.4 : 0.2,
    layers: ["top"],
    connectedTo: [`pad:${fixture.name}`, fixture.name],
  }))
  const connections: SimpleRouteConnection[] = fixtures.map((fixture) => ({
    name: fixture.name,
    pointsToConnect: [
      {
        ...fixture.source,
        layer: "top",
        pointId: `pad:${fixture.name}`,
        pcb_port_id: `port:${fixture.name}`,
      },
      { ...fixture.target, layer: "bottom" },
    ],
  }))
  const preparedConnections: PreparedConnection[] = fixtures.map(
    (_fixture, connectionIndex) => ({
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
    componentObstacles: sourceObstacles,
    componentBounds: { minX: -1.1, maxX: 1.1, minY: -4.1, maxY: 0.1 },
    sharedBoundary,
    xCoordinates: [-1, 1],
    yCoordinates: [-4, 0],
    pitchX: 2,
    pitchY: 4,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    nominalTraceWidth: traceWidth,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    defaultObstacleMargin: clearance,
    bounds: { minX: -2, maxX: 9, minY: -5, maxY: 8 },
    obstacles: sourceObstacles,
    connections,
    buses: [
      {
        busId: "DIAGONAL_BUS",
        connectionNames: fixtures.map((fixture) => fixture.name),
        maxLengthSkew: 0.25,
      },
    ],
  }
  const baselinePlans = fixtures.map((fixture, connectionIndex) =>
    createDiagonalPlan({
      fixture,
      connection: connections[connectionIndex]!,
      connectionIndex,
      sourceObstacle: sourceObstacles[connectionIndex]!,
    }),
  )

  const lengthMatching = matchBusPlanLengths({
    plans: baselinePlans,
    preparedBuses: [preparedBus],
    inputSrj,
    sharedBoundary,
    clearance,
  })
  expect(lengthMatching.plans).not.toBeNull()
  if (!lengthMatching.plans) {
    throw new Error("Expected diagonal length matching")
  }
  const matchedPlans = lengthMatching.plans

  const matchedShortPlan = matchedPlans.find(
    (plan) => plan.connectionName === "SHORT",
  )!
  expect(matchedShortPlan.length).toBeGreaterThan(baselinePlans[0]!.length)
  expect(matchedShortPlan.sourcePoint).toMatchObject({
    pointId: "pad:SHORT",
    pcb_port_id: "port:SHORT",
  })
  const matchedShortFirstWire = matchedShortPlan.trace.route.find(
    (point) => point.route_type === "wire",
  )
  expect(matchedShortFirstWire).toMatchObject({
    route_type: "wire",
    ...fixtures[0]!.source,
    layer: "top",
    start_pcb_port_id: "port:SHORT",
  })
  expect(
    matchedShortPlan.trace.route.filter((point) => point.route_type === "via"),
  ).toEqual([
    expect.objectContaining({
      ...fixtures[0]!.source,
      from_layer: "top",
      to_layer: "bottom",
    }),
  ])
  expect(matchedShortPlan.trace.route.at(-1)).toMatchObject({
    route_type: "wire",
    end_pcb_port_id: "boundary-port:SHORT",
  })
  expect(matchedShortPlan.trace.connectsTo).toEqual([
    "pad:SHORT",
    "port:SHORT",
    "exit:SHORT",
  ])

  const lengths = matchedPlans.map((plan) => plan.length)
  expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(
    0.250001,
  )
  for (const plan of matchedPlans) {
    expect(
      plan.trace.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(1)
    for (const segment of plan.segments) {
      const deltaX = Math.abs(segment.end.x - segment.start.x)
      const deltaY = Math.abs(segment.end.y - segment.start.y)
      expect(
        deltaX <= 1e-6 || deltaY <= 1e-6 || Math.abs(deltaX - deltaY) <= 1e-6,
      ).toBe(true)
    }
  }

  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: matchedPlans,
    layerNames: ["top", "bottom"],
  })
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans: matchedPlans,
      preparedBuses: [preparedBus],
      sharedBoundary,
      clearance,
    }),
  ).toMatchObject({ valid: true, issues: [] })
})
