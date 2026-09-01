import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { distancePointToSegment } from "lib/geometry"
import { fanoutPlansAreClear } from "lib/route-bus"
import {
  type RouteViaMinimalWindingParams,
  routeViaMinimalWinding,
} from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"

const traceWidth = 0.1
const clearance = 0.1
const viaDiameter = 0.3
const sharedBoundary = { minX: -2, maxX: 2, minY: -1, maxY: 1 }
const scarceViaSite = { x: 0, y: 0 }
const requiredViaToTraceDistance = viaDiameter / 2 + traceWidth / 2 + clearance

const connection: SimpleRouteConnection = {
  name: "SCARCE_SITE_ROUTE",
  pointsToConnect: [
    {
      x: -1.8,
      y: 0,
      layer: "top",
      pointId: "source-point",
      pcb_port_id: "source-port",
    },
    { x: 2, y: 0, layer: "inner1", pointId: "boundary-target" },
  ],
}

const sourceObstacle: Obstacle = {
  obstacleId: "source-pad",
  componentId: "U1",
  type: "rect",
  center: { x: -1.8, y: 0 },
  width: 0.2,
  height: 0.2,
  layers: ["top"],
  connectedTo: [connection.name, "source-point"],
}

const preparedConnection: PreparedConnection = {
  connection,
  connectionIndex: 0,
  sourcePoint: connection.pointsToConnect[0]!,
  sourcePointIndex: 0,
  sourceLayer: "top",
  sourceObstacle,
  targetPoint: connection.pointsToConnect[1]!,
}

const bus: PreparedBus = {
  busId: "SCARCE_SITE_BUS",
  direction: "right",
  exitEdge: "right",
  termination: { type: "boundary" },
  connections: [preparedConnection],
  componentId: "U1",
  componentObstacles: [sourceObstacle],
  componentBounds: { minX: -1.9, maxX: -1.7, minY: -0.1, maxY: 0.1 },
  sharedBoundary,
  xCoordinates: [-1.8],
  yCoordinates: [0],
  pitchX: 0.5,
  pitchY: 0.5,
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
  obstacles: [sourceObstacle],
  connections: [connection],
}

const commonRouteParams: RouteViaMinimalWindingParams = {
  srj,
  bus,
  targetLayer: "inner1",
  terminals: [
    {
      connection: preparedConnection,
      viaPoint: { x: -1.4, y: 0 },
      exitPoint: { x: 2, y: 0 },
    },
  ],
  acceptedPlans: [],
  layerNames: ["top", "inner1", "bottom"],
  traceWidth,
  viaDiameter,
  viaHoleDiameter: 0.15,
  clearance,
  allowBlindAndBuriedVias: false,
  maximumRouteOrderAttempts: 1,
}

const getTargetLayerDistanceToScarceSite = (
  plans: NonNullable<ReturnType<typeof routeViaMinimalWinding>>,
): number =>
  Math.min(
    ...plans[0]!.segments
      .filter((segment) => segment.layer === "inner1")
      .map((segment) =>
        distancePointToSegment(scarceViaSite, segment.start, segment.end),
      ),
  )

const countPreservedSites = (
  plans: NonNullable<ReturnType<typeof routeViaMinimalWinding>>,
  points: readonly { x: number; y: number }[],
): number => {
  const targetLayerSegments = plans[0]!.segments.filter(
    (segment) => segment.layer === "inner1",
  )
  return points.filter((point) =>
    targetLayerSegments.every(
      (segment) =>
        distancePointToSegment(point, segment.start, segment.end) >=
        requiredViaToTraceDistance - 1e-7,
    ),
  ).length
}

test("soft via-capacity groups preserve a scarce future via site", () => {
  const ordinaryPlans = routeViaMinimalWinding(commonRouteParams)
  const capacityAwarePlans = routeViaMinimalWinding({
    ...commonRouteParams,
    softViaCapacityGroups: [{ connectionIndex: 1, points: [scarceViaSite] }],
  })

  expect(ordinaryPlans).not.toBeNull()
  expect(capacityAwarePlans).not.toBeNull()

  expect(getTargetLayerDistanceToScarceSite(ordinaryPlans!)).toBeLessThan(
    requiredViaToTraceDistance,
  )
  expect(
    getTargetLayerDistanceToScarceSite(capacityAwarePlans!),
  ).toBeGreaterThanOrEqual(requiredViaToTraceDistance - 1e-7)
  expect(
    fanoutPlansAreClear({
      plans: capacityAwarePlans!,
      srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toBe(true)
})

test("Hall capacity preserves the required number of distinct via sites", () => {
  const hallCandidateSites = [
    { x: -0.4, y: 0 },
    { x: 0.4, y: 0 },
    { x: 0, y: 0.8 },
  ]
  const ordinaryPlans = routeViaMinimalWinding(commonRouteParams)
  const capacityAwarePlans = routeViaMinimalWinding({
    ...commonRouteParams,
    softViaCapacityGroups: [
      {
        connectionIndex: 1,
        connectionIndexes: [1, 2],
        points: hallCandidateSites,
        minimumRemainingPointCount: 2,
      },
    ],
  })

  expect(ordinaryPlans).not.toBeNull()
  expect(countPreservedSites(ordinaryPlans!, hallCandidateSites)).toBe(1)
  expect(capacityAwarePlans).not.toBeNull()
  expect(
    countPreservedSites(capacityAwarePlans!, hallCandidateSites),
  ).toBeGreaterThanOrEqual(2)
  expect(
    fanoutPlansAreClear({
      plans: capacityAwarePlans!,
      srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toBe(true)

  const endpointConstrainedSites = [
    commonRouteParams.terminals[0]!.viaPoint,
    commonRouteParams.terminals[0]!.exitPoint,
    { x: 0, y: 0.8 },
  ]
  const routeLeavingOneSite = routeViaMinimalWinding({
    ...commonRouteParams,
    softViaCapacityGroups: [
      {
        connectionIndex: 1,
        connectionIndexes: [1, 2],
        points: endpointConstrainedSites,
      },
    ],
  })
  const rejectedBelowHallMinimum = routeViaMinimalWinding({
    ...commonRouteParams,
    softViaCapacityGroups: [
      {
        connectionIndex: 1,
        connectionIndexes: [1, 2],
        points: endpointConstrainedSites,
        minimumRemainingPointCount: 2,
      },
    ],
  })

  expect(routeLeavingOneSite).not.toBeNull()
  expect(
    countPreservedSites(routeLeavingOneSite!, endpointConstrainedSites),
  ).toBe(1)
  expect(rejectedBelowHallMinimum).toBeNull()
})
