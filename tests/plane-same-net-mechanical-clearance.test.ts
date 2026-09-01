import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { fanoutPlansAreClear } from "lib/route-bus"
import type { FanoutRoutePlan, Point2D, RoutedVia } from "lib/types"

const traceWidth = 0.1
const clearance = 0.1
const viaDiameter = 0.25
const viaHoleDiameter = 0.15
const sharedBoundary = { minX: -2, maxX: 2, minY: -1, maxY: 1 }

function createConnection(params: {
  name: string
  netName: string
  viaPoint: Point2D
}): SimpleRouteConnection {
  const { name, netName, viaPoint } = params
  return {
    name,
    netConnectionName: netName,
    pointsToConnect: [
      {
        x: -1,
        y: 0,
        layer: "top",
        pointId: `${name}-source`,
        pcb_port_id: `${name}-source-port`,
      },
      { ...viaPoint, layer: "bottom", pointId: `${name}-plane` },
    ],
  }
}

function createPlanePlan(params: {
  connection: SimpleRouteConnection
  connectionIndex: number
  viaPoint: Point2D
}): FanoutRoutePlan {
  const { connection, connectionIndex, viaPoint } = params
  const sourcePoint = connection.pointsToConnect[0]!
  const sourceObstacle: Obstacle = {
    obstacleId: `${connection.name}-source-pad`,
    componentId: `${connection.name}-component`,
    type: "rect",
    center: { x: sourcePoint.x, y: sourcePoint.y },
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: [connection.name, sourcePoint.pointId!],
  }
  const via: RoutedVia = {
    center: { ...viaPoint },
    diameter: viaDiameter,
    holeDiameter: viaHoleDiameter,
    fromLayer: "top",
    toLayer: "bottom",
    spanLayers: ["top", "bottom"],
  }
  const segment = {
    start: { x: sourcePoint.x, y: sourcePoint.y },
    end: { ...viaPoint },
    width: traceWidth,
    layer: "top",
  }
  return {
    busId: `${connection.name}-bus`,
    connectionName: connection.name,
    connectionIndex,
    sourcePointIndex: 0,
    sourcePoint,
    sourceObstacle,
    sourceLayer: "top",
    targetPoint: connection.pointsToConnect[1]!,
    targetLayer: "bottom",
    termination: { type: "plane", layer: "bottom" },
    direction: "right",
    exitPoint: { ...viaPoint },
    trace: {
      type: "pcb_trace",
      pcb_trace_id: `fanout:${connection.name}`,
      connection_name: connection.name,
      connectsTo: [connection.name, sourcePoint.pointId!],
      route: [
        {
          route_type: "wire",
          x: sourcePoint.x,
          y: sourcePoint.y,
          width: traceWidth,
          layer: "top",
          start_pcb_port_id: sourcePoint.pcb_port_id,
        },
        {
          route_type: "wire",
          ...viaPoint,
          width: traceWidth,
          layer: "top",
        },
        {
          route_type: "via",
          ...viaPoint,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: viaDiameter,
          via_hole_diameter: viaHoleDiameter,
        },
        {
          route_type: "wire",
          ...viaPoint,
          width: traceWidth,
          layer: "bottom",
        },
      ],
    },
    segments: [segment],
    via,
    length: Math.hypot(viaPoint.x - sourcePoint.x, viaPoint.y - sourcePoint.y),
  }
}

function createSrj(
  connections: SimpleRouteConnection[],
  traces: NonNullable<SimpleRouteJson["traces"]> = [],
): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: traceWidth,
    nominalTraceWidth: traceWidth,
    minViaPadDiameter: viaDiameter,
    minViaHoleDiameter: viaHoleDiameter,
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    bounds: sharedBoundary,
    obstacles: [],
    connections,
    traces,
  }
}

test("one plane plan keeps mechanical clearance between source and endpoint drills", () => {
  const connection = createConnection({
    name: "GND_WITH_ENDPOINT",
    netName: "GND",
    viaPoint: { x: 0, y: 0 },
  })
  const basePlan = createPlanePlan({
    connection,
    connectionIndex: 0,
    viaPoint: { x: 0, y: 0 },
  })
  const withEndpointVia = (center: Point2D): FanoutRoutePlan => ({
    ...basePlan,
    planeEndpointVia: {
      center,
      diameter: viaDiameter,
      holeDiameter: viaHoleDiameter,
      fromLayer: "bottom",
      toLayer: "top",
      spanLayers: ["top", "bottom"],
    },
  })
  const srj = createSrj([connection])

  expect(
    fanoutPlansAreClear({
      plans: [withEndpointVia({ x: 0.26, y: 0 })],
      srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(true)
  expect(
    fanoutPlansAreClear({
      plans: [withEndpointVia({ x: 0.24, y: 0 })],
      srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(false)
})

test("same-net plane plans may share copper but not overlapping drill clearance", () => {
  const firstConnection = createConnection({
    name: "GND_A",
    netName: "GND",
    viaPoint: { x: 0, y: 0 },
  })
  const clearHoleConnection = createConnection({
    name: "GND_B",
    netName: "GND",
    viaPoint: { x: 0.26, y: 0 },
  })
  const firstPlan = createPlanePlan({
    connection: firstConnection,
    connectionIndex: 0,
    viaPoint: { x: 0, y: 0 },
  })
  const clearHolePlan = createPlanePlan({
    connection: clearHoleConnection,
    connectionIndex: 1,
    viaPoint: { x: 0.26, y: 0 },
  })
  const sameNetSrj = createSrj([firstConnection, clearHoleConnection])

  // The outer pads violate ordinary copper clearance (0.35 mm required), but
  // the 0.15 mm drills satisfy the 0.25 mm mechanical minimum.
  expect(
    fanoutPlansAreClear({
      plans: [firstPlan, clearHolePlan],
      srj: sameNetSrj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(true)

  const closeHoleConnection = createConnection({
    name: "GND_CLOSE",
    netName: "GND",
    viaPoint: { x: 0.24, y: 0 },
  })
  const closeHolePlan = createPlanePlan({
    connection: closeHoleConnection,
    connectionIndex: 2,
    viaPoint: { x: 0.24, y: 0 },
  })
  expect(
    fanoutPlansAreClear({
      plans: [firstPlan, closeHolePlan],
      srj: createSrj([firstConnection, closeHoleConnection]),
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(false)

  const differentNetConnection = createConnection({
    name: "VDD_B",
    netName: "VDD",
    viaPoint: { x: 0.26, y: 0 },
  })
  const differentNetPlan = createPlanePlan({
    connection: differentNetConnection,
    connectionIndex: 3,
    viaPoint: { x: 0.26, y: 0 },
  })
  expect(
    fanoutPlansAreClear({
      plans: [firstPlan, differentNetPlan],
      srj: createSrj([firstConnection, differentNetConnection]),
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(false)
})

test("plane sharing applies the same copper and drill rules to existing traces", () => {
  const existingConnection = createConnection({
    name: "EXISTING_GND",
    netName: "GND",
    viaPoint: { x: 0, y: 0 },
  })
  const planConnection = createConnection({
    name: "PLANE_GND",
    netName: "GND",
    viaPoint: { x: 0.26, y: 0 },
  })
  const existingTrace: NonNullable<SimpleRouteJson["traces"]>[number] = {
    type: "pcb_trace",
    pcb_trace_id: "existing-ground-trace",
    connection_name: existingConnection.name,
    connectsTo: [existingConnection.name],
    route: [
      {
        route_type: "wire",
        x: -1,
        y: 0,
        width: traceWidth,
        layer: "top",
      },
      {
        route_type: "wire",
        x: 0,
        y: 0,
        width: traceWidth,
        layer: "top",
      },
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      },
      {
        route_type: "wire",
        x: 0,
        y: 0,
        width: traceWidth,
        layer: "bottom",
      },
    ],
  }
  const clearHolePlan = createPlanePlan({
    connection: planConnection,
    connectionIndex: 1,
    viaPoint: { x: 0.26, y: 0 },
  })
  const sameNetSrj = createSrj(
    [existingConnection, planConnection],
    [existingTrace],
  )

  expect(
    fanoutPlansAreClear({
      plans: [clearHolePlan],
      srj: sameNetSrj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(true)

  const closeHolePlan = createPlanePlan({
    connection: planConnection,
    connectionIndex: 1,
    viaPoint: { x: 0.24, y: 0 },
  })
  expect(
    fanoutPlansAreClear({
      plans: [closeHolePlan],
      srj: sameNetSrj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(false)

  const differentNetSrj = createSrj(
    [{ ...existingConnection, netConnectionName: "VDD" }, planConnection],
    [existingTrace],
  )
  expect(
    fanoutPlansAreClear({
      plans: [clearHolePlan],
      srj: differentNetSrj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(false)
})
