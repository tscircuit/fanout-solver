import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  RoutedVia,
} from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"

const sharedBoundary = { minX: -1, maxX: 2, minY: -1, maxY: 3 }

function createConnection(
  name: string,
  source: Point2D,
  target: Point2D,
  netConnectionName = name,
): SimpleRouteConnection {
  return {
    name,
    netConnectionName,
    pointsToConnect: [
      {
        ...source,
        layer: "top",
        pointId: `${name}-source`,
        pcb_port_id: `${name}-port`,
      },
      { ...target, layer: "top", pointId: `${name}-target` },
    ],
  }
}

function createSourceObstacle(
  connection: SimpleRouteConnection,
  componentId = "U1",
): Obstacle {
  const source = connection.pointsToConnect[0]!
  return {
    obstacleId: `${connection.name}-source-pad`,
    componentId,
    type: "rect",
    center: { x: source.x, y: source.y },
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: [connection.name, source.pointId!],
  }
}

function createPlan(params: {
  connection: SimpleRouteConnection
  connectionIndex: number
  sourceObstacle: Obstacle
  exit: Point2D
  targetLayer?: string
  via?: RoutedVia
}): FanoutRoutePlan {
  const {
    connection,
    connectionIndex,
    sourceObstacle,
    exit,
    targetLayer = "top",
    via,
  } = params
  const source = connection.pointsToConnect[0]!
  const segments = via
    ? [
        {
          start: { x: source.x, y: source.y },
          end: via.center,
          width: 0.1,
          layer: "top",
        },
        {
          start: via.center,
          end: exit,
          width: 0.1,
          layer: targetLayer,
        },
      ]
    : [
        {
          start: { x: source.x, y: source.y },
          end: exit,
          width: 0.1,
          layer: targetLayer,
        },
      ]
  const route: FanoutRoutePlan["trace"]["route"] = [
    {
      route_type: "wire",
      x: source.x,
      y: source.y,
      width: 0.1,
      layer: "top",
      start_pcb_port_id: source.pcb_port_id,
    },
  ]
  if (via) {
    route.push(
      {
        route_type: "wire",
        x: via.center.x,
        y: via.center.y,
        width: 0.1,
        layer: "top",
      },
      {
        route_type: "via",
        x: via.center.x,
        y: via.center.y,
        from_layer: via.fromLayer,
        to_layer: via.toLayer,
        via_diameter: via.diameter,
        via_hole_diameter: via.holeDiameter,
      },
      {
        route_type: "wire",
        x: via.center.x,
        y: via.center.y,
        width: 0.1,
        layer: targetLayer,
      },
    )
  }
  route.push({
    route_type: "wire",
    x: exit.x,
    y: exit.y,
    width: 0.1,
    layer: targetLayer,
  })
  return {
    busId: connection.name,
    connectionName: connection.name,
    connectionIndex,
    sourcePointIndex: 0,
    sourcePoint: source,
    sourceObstacle,
    sourceLayer: "top",
    targetLayer,
    termination: { type: "boundary" },
    direction: "right",
    exitPoint: exit,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: `fanout:${connection.name}`,
      connection_name: connection.name,
      connectsTo: [connection.name, source.pointId!],
      route,
    },
    segments,
    via,
    length: segments.reduce(
      (total, segment) =>
        total +
        Math.hypot(
          segment.end.x - segment.start.x,
          segment.end.y - segment.start.y,
        ),
      0,
    ),
  }
}

function createPreparedBus(
  plan: FanoutRoutePlan,
  connection: SimpleRouteConnection,
  componentObstacles: Obstacle[],
): PreparedBus {
  return {
    busId: plan.busId,
    direction: "right",
    termination: { type: "boundary" },
    connections: [
      {
        connection,
        connectionIndex: plan.connectionIndex,
        sourcePoint: connection.pointsToConnect[0]!,
        sourcePointIndex: 0,
        sourceLayer: "top",
        sourceObstacle: plan.sourceObstacle,
        targetPoint: connection.pointsToConnect[1]!,
      },
    ],
    componentId: "U1",
    componentObstacles,
    componentBounds: { minX: -0.1, maxX: 0.1, minY: -0.1, maxY: 2.1 },
    sharedBoundary,
    xCoordinates: [0],
    yCoordinates: [0, 2],
    pitchX: 2,
    pitchY: 2,
  }
}

function validateFixture(params: {
  connections: SimpleRouteConnection[]
  obstacles: Obstacle[]
  plans: FanoutRoutePlan[]
}) {
  const { connections, obstacles, plans } = params
  const inputSrj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: sharedBoundary,
    obstacles,
    connections,
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans,
    layerNames: ["top", "inner1", "inner2", "bottom"],
  })
  return validateFanoutSolution({
    inputSrj,
    outputSrj,
    plans,
    preparedBuses: plans.map((plan) =>
      createPreparedBus(plan, connections[plan.connectionIndex]!, obstacles),
    ),
    sharedBoundary,
    clearance: 0.1,
  })
}

test("validation rejects different-net trace intersections", () => {
  const connections = [
    createConnection("NET_A", { x: 0, y: 0 }, { x: 3, y: 0 }),
    createConnection("NET_B", { x: 0, y: 2 }, { x: 3, y: 2 }),
  ]
  const obstacles = connections.map((connection) =>
    createSourceObstacle(connection),
  )
  const plans = [
    createPlan({
      connection: connections[0]!,
      connectionIndex: 0,
      sourceObstacle: obstacles[0]!,
      exit: { x: 2, y: 2 },
    }),
    createPlan({
      connection: connections[1]!,
      connectionIndex: 1,
      sourceObstacle: obstacles[1]!,
      exit: { x: 2, y: 0 },
    }),
  ]

  const report = validateFixture({ connections, obstacles, plans })

  expect(report.valid).toBe(false)
  expect(
    report.issues.some(
      (issue) => issue.code === "different-net-trace-clearance",
    ),
  ).toBe(true)
})

test("validation rejects same-layer traces inside different-net pads", () => {
  const connection = createConnection("NET_A", { x: 0, y: 1 }, { x: 3, y: 1 })
  const sourceObstacle = createSourceObstacle(connection)
  const blockingPad: Obstacle = {
    obstacleId: "different-net-pad",
    componentId: "C1",
    type: "rect",
    center: { x: 1, y: 1 },
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: ["NET_B"],
  }
  const plan = createPlan({
    connection,
    connectionIndex: 0,
    sourceObstacle,
    exit: { x: 2, y: 1 },
  })

  const report = validateFixture({
    connections: [connection],
    obstacles: [sourceObstacle, blockingPad],
    plans: [plan],
  })

  expect(report.valid).toBe(false)
  expect(
    report.issues.some((issue) => issue.code === "obstacle-clearance"),
  ).toBe(true)
})

test("validation rejects vias inside different-net obstacles on an intermediate layer", () => {
  const connection = createConnection("NET_A", { x: 0, y: 1 }, { x: 3, y: 1 })
  const sourceObstacle = createSourceObstacle(connection)
  const blockingPad: Obstacle = {
    obstacleId: "inner1-different-net-pad",
    componentId: "J1",
    type: "rect",
    center: { x: 1, y: 1 },
    width: 0.4,
    height: 0.4,
    layers: ["inner1"],
    connectedTo: ["NET_B"],
  }
  const via: RoutedVia = {
    center: { x: 1, y: 1 },
    diameter: 0.25,
    holeDiameter: 0.15,
    fromLayer: "top",
    toLayer: "inner2",
    spanLayers: ["top", "inner1", "inner2"],
  }
  const plan = createPlan({
    connection,
    connectionIndex: 0,
    sourceObstacle,
    exit: { x: 2, y: 1 },
    targetLayer: "inner2",
    via,
  })

  const report = validateFixture({
    connections: [connection],
    obstacles: [sourceObstacle, blockingPad],
    plans: [plan],
  })

  expect(report.valid).toBe(false)
  expect(
    report.issues.some((issue) => issue.code === "via-obstacle-clearance"),
  ).toBe(true)
})

test("validation follows merged same-net copper to prove every branch breaks out", () => {
  const connections = [
    createConnection("POWER_A", { x: 0, y: 0 }, { x: 3, y: 0 }, "POWER"),
    createConnection("POWER_B", { x: 0, y: 1 }, { x: 3, y: 1 }, "POWER"),
  ]
  const obstacles = connections.map((connection) =>
    createSourceObstacle(connection),
  )
  const plans = [
    createPlan({
      connection: connections[0]!,
      connectionIndex: 0,
      sourceObstacle: obstacles[0]!,
      exit: { x: 2, y: 0 },
    }),
    createPlan({
      connection: connections[1]!,
      connectionIndex: 1,
      sourceObstacle: obstacles[1]!,
      exit: { x: 1, y: 0 },
    }),
  ]

  const report = validateFixture({ connections, obstacles, plans })

  expect(report).toMatchObject({
    valid: true,
    checkedConnectionCount: 2,
    brokenOutConnectionCount: 2,
    issues: [],
  })
})

test("validation does not count a disconnected same-net branch as broken out", () => {
  const connections = [
    createConnection("POWER_A", { x: 0, y: 0 }, { x: 3, y: 0 }, "POWER"),
    createConnection("POWER_B", { x: 0, y: 1 }, { x: 3, y: 1 }, "POWER"),
  ]
  const obstacles = connections.map((connection) =>
    createSourceObstacle(connection),
  )
  const plans = [
    createPlan({
      connection: connections[0]!,
      connectionIndex: 0,
      sourceObstacle: obstacles[0]!,
      exit: { x: 2, y: 0 },
    }),
    createPlan({
      connection: connections[1]!,
      connectionIndex: 1,
      sourceObstacle: obstacles[1]!,
      exit: { x: 1, y: 1 },
    }),
  ]

  const report = validateFixture({ connections, obstacles, plans })

  expect(report.valid).toBe(false)
  expect(report.brokenOutConnectionCount).toBe(1)
  expect(
    report.issues.some(
      (issue) =>
        issue.code === "not-broken-out" && issue.connectionName === "POWER_B",
    ),
  ).toBe(true)
})
