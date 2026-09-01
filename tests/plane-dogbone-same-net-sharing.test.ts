import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import {
  type ComponentDogboneViaPath,
  matchComponentDogboneViaPaths,
} from "lib/match-component-dogbone-via-sites"
import { connectionsShareElectricalNet } from "lib/net-identity"
import type { PreparedBus, PreparedConnection } from "lib/types"

const sourcePoints = [
  { x: -0.5, y: -0.25 },
  { x: -0.5, y: 0.25 },
]

const fixedPaths: ComponentDogboneViaPath[] = [
  {
    point: { x: 0.5, y: 0.25 },
    path: [
      sourcePoints[0]!,
      { x: -0.25, y: 0 },
      { x: 0.25, y: 0 },
      { x: 0.5, y: 0.25 },
    ],
  },
  {
    point: { x: 0.5, y: -0.25 },
    path: [
      sourcePoints[1]!,
      { x: -0.25, y: 0 },
      { x: 0.25, y: 0 },
      { x: 0.5, y: -0.25 },
    ],
  },
]

function createFixture(secondNet: string): {
  srj: SimpleRouteJson
  buses: PreparedBus[]
} {
  const connections: SimpleRouteConnection[] = sourcePoints.map(
    (sourcePoint, connectionIndex) => ({
      name: `DROP_${connectionIndex}`,
      netConnectionName: connectionIndex === 0 ? "GND" : secondNet,
      pointsToConnect: [
        {
          ...sourcePoint,
          layer: "top",
          pointId: `pad-${connectionIndex}`,
        },
      ],
    }),
  )
  const obstacles: Obstacle[] = sourcePoints.map((center, connectionIndex) => ({
    obstacleId: `pad-${connectionIndex}`,
    componentId: "U1",
    type: "rect",
    center,
    width: 0.1,
    height: 0.1,
    layers: ["top"],
    connectedTo: [connections[connectionIndex]!.name, `pad-${connectionIndex}`],
  }))
  const preparedConnections: PreparedConnection[] = connections.map(
    (connection, connectionIndex) => ({
      connection,
      connectionIndex,
      sourcePoint: connection.pointsToConnect[0]!,
      sourcePointIndex: 0,
      sourceLayer: "top",
      sourceObstacle: obstacles[connectionIndex]!,
      targetPoint: connection.pointsToConnect[0]!,
    }),
  )
  const buses: PreparedBus[] = preparedConnections.map(
    (connection, connectionIndex) => ({
      busId: `plane-${connectionIndex}`,
      direction: "right",
      termination: { type: "plane", layer: "inner1" },
      connections: [connection],
      componentId: "U1",
      componentObstacles: obstacles,
      componentBounds: { minX: -0.55, maxX: -0.45, minY: -0.3, maxY: 0.3 },
      sharedBoundary: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
      xCoordinates: [-0.5],
      yCoordinates: [-0.25, 0.25],
      pitchX: 0.5,
      pitchY: 0.5,
    }),
  )
  return {
    buses,
    srj: {
      layerCount: 4,
      minTraceWidth: 0.1,
      nominalTraceWidth: 0.1,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minTraceToPadEdgeClearance: 0.1,
      minViaEdgeToPadEdgeClearance: 0.1,
      defaultObstacleMargin: 0.1,
      bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
      obstacles,
      connections,
    },
  }
}

function matchFixedPlanePaths(secondNet: string) {
  const { buses, srj } = createFixture(secondNet)
  const planeConnectionIndexes = new Set(
    buses.flatMap((bus) =>
      bus.termination.type === "plane"
        ? bus.connections.map((connection) => connection.connectionIndex)
        : [],
    ),
  )
  const connectionNameByIndex = new Map(
    buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, connection.connection.name] as const,
      ),
    ),
  )
  const allowSameNetMerges = false
  return matchComponentDogboneViaPaths(buses, {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
    holeToHoleClearance: 0.1,
    maximumSearchStates: 100,
    fixedViaPathsByConnectionIndex: new Map(
      fixedPaths.map((path, connectionIndex) => [connectionIndex, path]),
    ),
    canShareCopper: (firstConnectionIndex, secondConnectionIndex) => {
      if (
        !allowSameNetMerges &&
        !(
          planeConnectionIndexes.has(firstConnectionIndex) &&
          planeConnectionIndexes.has(secondConnectionIndex)
        )
      ) {
        return false
      }
      const firstName = connectionNameByIndex.get(firstConnectionIndex)
      const secondName = connectionNameByIndex.get(secondConnectionIndex)
      return Boolean(
        firstName &&
          secondName &&
          connectionsShareElectricalNet(srj, firstName, secondName),
      )
    },
  })
}

test("plane path matching shares same-net copper without enabling general merges", () => {
  expect(matchFixedPlanePaths("GND")).toEqual(
    new Map(fixedPaths.map((path, connectionIndex) => [connectionIndex, path])),
  )
  expect(matchFixedPlanePaths("VDD")).toBeNull()
})
