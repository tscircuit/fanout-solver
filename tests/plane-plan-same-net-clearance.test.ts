import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { fanoutPlansAreClear } from "lib/route-bus"
import type {
  FanoutBusTermination,
  FanoutRoutePlan,
  PreparedBus,
  RoutedSegment,
} from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"

const sharedBoundary = { minX: -1, maxX: 1, minY: -1, maxY: 1 }
const clearance = 0.1

function createFixture(secondNet = "POWER") {
  const connections: SimpleRouteConnection[] = [
    {
      name: "POWER_PLANE",
      netConnectionName: "POWER",
      pointsToConnect: [
        {
          x: -0.8,
          y: 0,
          layer: "top",
          pointId: "plane-source",
          pcb_port_id: "plane-source",
        },
      ],
    },
    {
      name: "POWER_BRANCH",
      netConnectionName: secondNet,
      pointsToConnect: [
        {
          x: -0.8,
          y: 0.5,
          layer: "top",
          pointId: "branch-source",
          pcb_port_id: "branch-source",
        },
        { x: 1.2, y: 0, layer: "top", pointId: "branch-target" },
      ],
    },
  ]
  const obstacles: Obstacle[] = connections.map((connection) => ({
    obstacleId: `${connection.name}-pad`,
    componentId: "U1",
    type: "rect",
    center: {
      x: connection.pointsToConnect[0]!.x,
      y: connection.pointsToConnect[0]!.y,
    },
    width: 0.1,
    height: 0.1,
    layers: ["top"],
    connectedTo: [connection.name, connection.pointsToConnect[0]!.pointId!],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    defaultObstacleMargin: clearance,
    bounds: sharedBoundary,
    connections,
    obstacles,
  }
  return { connections, obstacles, srj }
}

function getLength(segments: readonly RoutedSegment[]): number {
  return segments.reduce(
    (total, segment) =>
      total +
      Math.hypot(
        segment.end.x - segment.start.x,
        segment.end.y - segment.start.y,
      ),
    0,
  )
}

function createPlans(params: {
  connections: SimpleRouteConnection[]
  obstacles: Obstacle[]
  firstTermination?: FanoutBusTermination
}): FanoutRoutePlan[] {
  const { connections, obstacles } = params
  const planeSegments: RoutedSegment[] = [
    {
      start: { x: -0.8, y: 0 },
      end: { x: 0.4, y: 0 },
      width: 0.1,
      layer: "top",
    },
  ]
  const branchSegments: RoutedSegment[] = [
    {
      start: { x: -0.8, y: 0.5 },
      end: { x: -0.3, y: 0 },
      width: 0.1,
      layer: "top",
    },
    {
      start: { x: -0.3, y: 0 },
      end: { x: 1, y: 0 },
      width: 0.1,
      layer: "top",
    },
  ]
  const via = {
    center: { x: 0.4, y: 0 },
    fromLayer: "top",
    toLayer: "inner1",
    spanLayers: ["top", "inner1", "inner2", "bottom"],
    diameter: 0.25,
    holeDiameter: 0.15,
  }
  return [
    {
      busId: "plane",
      connectionName: connections[0]!.name,
      connectionIndex: 0,
      sourcePointIndex: 0,
      sourcePoint: connections[0]!.pointsToConnect[0]!,
      sourceObstacle: obstacles[0]!,
      sourceLayer: "top",
      targetPoint: connections[0]!.pointsToConnect[0]!,
      targetLayer: "inner1",
      termination: params.firstTermination ?? {
        type: "plane",
        layer: "inner1",
      },
      direction: "right",
      exitPoint: via.center,
      trace: {
        type: "pcb_trace",
        pcb_trace_id: "fanout:plane",
        connection_name: connections[0]!.name,
        connectsTo: [connections[0]!.name, "plane-source"],
        route: [
          {
            route_type: "wire",
            x: -0.8,
            y: 0,
            width: 0.1,
            layer: "top",
            start_pcb_port_id: "plane-source",
          },
          { route_type: "wire", x: 0.4, y: 0, width: 0.1, layer: "top" },
          {
            route_type: "via",
            x: 0.4,
            y: 0,
            from_layer: "top",
            to_layer: "inner1",
            via_diameter: 0.25,
            via_hole_diameter: 0.15,
          },
          { route_type: "wire", x: 0.4, y: 0, width: 0.1, layer: "inner1" },
        ],
      },
      segments: planeSegments,
      via,
      length: getLength(planeSegments),
    },
    {
      busId: "boundary",
      connectionName: connections[1]!.name,
      connectionIndex: 1,
      sourcePointIndex: 0,
      sourcePoint: connections[1]!.pointsToConnect[0]!,
      sourceObstacle: obstacles[1]!,
      sourceLayer: "top",
      targetPoint: connections[1]!.pointsToConnect[1]!,
      targetLayer: "top",
      termination: { type: "boundary" },
      direction: "right",
      exitEdge: "right",
      exitPoint: { x: 1, y: 0 },
      trace: {
        type: "pcb_trace",
        pcb_trace_id: "fanout:boundary",
        connection_name: connections[1]!.name,
        connectsTo: [connections[1]!.name, "branch-source"],
        route: [
          {
            route_type: "wire",
            x: -0.8,
            y: 0.5,
            width: 0.1,
            layer: "top",
            start_pcb_port_id: "branch-source",
          },
          { route_type: "wire", x: -0.3, y: 0, width: 0.1, layer: "top" },
          { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "top" },
        ],
      },
      segments: branchSegments,
      length: getLength(branchSegments),
    },
  ]
}

function createPreparedBuses(params: {
  plans: FanoutRoutePlan[]
  connections: SimpleRouteConnection[]
  obstacles: Obstacle[]
}): PreparedBus[] {
  const { plans, connections, obstacles } = params
  return plans.map((plan, connectionIndex) => ({
    busId: plan.busId,
    direction: "right",
    ...(plan.exitEdge ? { exitEdge: plan.exitEdge } : {}),
    termination: plan.termination,
    connections: [
      {
        connection: connections[connectionIndex]!,
        connectionIndex,
        sourcePoint: connections[connectionIndex]!.pointsToConnect[0]!,
        sourcePointIndex: 0,
        sourceLayer: "top",
        sourceObstacle: obstacles[connectionIndex]!,
        targetPoint:
          connections[connectionIndex]!.pointsToConnect[1] ??
          connections[connectionIndex]!.pointsToConnect[0]!,
      },
    ],
    componentId: "U1",
    componentObstacles: obstacles,
    componentBounds: { minX: -0.85, maxX: -0.75, minY: -0.05, maxY: 0.55 },
    sharedBoundary,
    xCoordinates: [-0.8],
    yCoordinates: [0, 0.5],
    pitchX: 0.5,
    pitchY: 0.5,
  }))
}

test("a plane plan may merge with a same-net plan without enabling general merges", () => {
  const sameNet = createFixture()
  const sameNetPlans = createPlans(sameNet)
  expect(
    fanoutPlansAreClear({
      plans: sameNetPlans,
      srj: sameNet.srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(true)

  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: sameNet.srj,
    plans: sameNetPlans,
    layerNames: ["top", "inner1", "inner2", "bottom"],
  })
  expect(
    validateFanoutSolution({
      inputSrj: sameNet.srj,
      outputSrj,
      plans: sameNetPlans,
      preparedBuses: createPreparedBuses({
        plans: sameNetPlans,
        connections: sameNet.connections,
        obstacles: sameNet.obstacles,
      }),
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  const differentNet = createFixture("OTHER")
  expect(
    fanoutPlansAreClear({
      plans: createPlans(differentNet),
      srj: differentNet.srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(false)

  expect(
    fanoutPlansAreClear({
      plans: createPlans({
        ...sameNet,
        firstTermination: { type: "boundary" },
      }),
      srj: sameNet.srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(false)
})
