import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { fanoutPlansAreClear } from "lib/route-bus"
import {
  type RouteViaMinimalWindingParams,
  routeViaMinimalWinding,
} from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"

const traceWidth = 0.1
const clearance = 0.1
const viaDiameter = 0.3
const sharedBoundary = { minX: -2, maxX: 2, minY: -2, maxY: 2 }
const viaXs = [-1.5, -0.7, -1.1, -0.3]
const viaTracks = [1.5, -0.3, 0.3, 0.9]
const exitTracks = [-1.5, -0.5, 0.5, 1.5]

const connections: SimpleRouteConnection[] = []
const sourceObstacles: Obstacle[] = []
const preparedConnections: PreparedConnection[] = []
for (let index = 0; index < viaXs.length; index++) {
  const connectionName = `N${index}`
  const sourcePoint = {
    x: viaXs[index]! - 0.4,
    y: viaTracks[index]!,
    layer: "top",
    pointId: `source-${index}`,
  }
  const targetPoint = {
    x: sharedBoundary.maxX,
    y: exitTracks[index]!,
    layer: "inner1",
    pointId: `exit-${index}`,
  }
  const connection: SimpleRouteConnection = {
    name: connectionName,
    pointsToConnect: [sourcePoint, targetPoint],
  }
  const sourceObstacle: Obstacle = {
    obstacleId: `source-pad-${index}`,
    componentId: "U1",
    type: "rect",
    center: sourcePoint,
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: [connectionName, sourcePoint.pointId],
  }
  connections.push(connection)
  sourceObstacles.push(sourceObstacle)
  preparedConnections.push({
    connection,
    connectionIndex: index,
    sourcePoint,
    sourcePointIndex: 0,
    sourceLayer: "top",
    sourceObstacle,
    targetPoint,
  })
}

const bus: PreparedBus = {
  busId: "JOINT_WINDING_BUS",
  direction: "right",
  exitEdge: "right",
  termination: { type: "boundary" },
  connections: preparedConnections,
  componentId: "U1",
  componentObstacles: sourceObstacles,
  componentBounds: { minX: -2, maxX: -0.1, minY: -0.5, maxY: 1.7 },
  sharedBoundary,
  xCoordinates: viaXs,
  yCoordinates: viaTracks,
  pitchX: 0.4,
  pitchY: 0.6,
}

const srj: SimpleRouteJson = {
  layerCount: 3,
  minTraceWidth: traceWidth,
  nominalTraceWidth: traceWidth,
  minViaPadDiameter: viaDiameter,
  minViaHoleDiameter: 0.15,
  minTraceToPadEdgeClearance: clearance,
  minViaEdgeToPadEdgeClearance: clearance,
  defaultObstacleMargin: clearance,
  bounds: sharedBoundary,
  obstacles: sourceObstacles,
  connections,
}

const commonRouteParams: RouteViaMinimalWindingParams = {
  srj,
  bus,
  targetLayer: "inner1",
  terminals: preparedConnections.map((connection, index) => ({
    connection,
    viaPoint: { x: viaXs[index]!, y: viaTracks[index]! },
    exitPoint: { x: sharedBoundary.maxX, y: exitTracks[index]! },
  })),
  acceptedPlans: [],
  layerNames: ["top", "inner1", "bottom"],
  traceWidth,
  viaDiameter,
  viaHoleDiameter: 0.15,
  clearance,
  allowBlindAndBuriedVias: false,
  maximumRouteOrderAttempts: 1,
}

test("bounded joint winding search recovers from a greedy route-order dead end", () => {
  expect(routeViaMinimalWinding(commonRouteParams)).toBeNull()

  const expandedStateBudget = { remaining: 400_000 }
  const plans = routeViaMinimalWinding({
    ...commonRouteParams,
    expandedStateBudget,
    enableJointRouteSearch: true,
  })

  expect(plans).toHaveLength(4)
  expect(expandedStateBudget.remaining).toBeGreaterThan(0)
  expect(expandedStateBudget.remaining).toBeLessThan(400_000)
  expect(
    fanoutPlansAreClear({
      plans: plans!,
      srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toBe(true)
})
