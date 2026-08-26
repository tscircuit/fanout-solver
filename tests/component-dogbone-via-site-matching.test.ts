import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  segmentsAreClear,
} from "lib/geometry"
import { matchComponentDogboneViaSites } from "lib/match-component-dogbone-via-sites"
import type {
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "lib/types"

const padPositions: Point2D[] = [
  { x: 0, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
]

function createFixture(): {
  buses: PreparedBus[]
  obstacles: Obstacle[]
  connections: PreparedConnection[]
} {
  const obstacles: Obstacle[] = padPositions.map((center, index) => ({
    obstacleId: `pad-${index}`,
    componentId: "U1",
    type: "rect",
    center,
    width: 0.6,
    height: 0.6,
    layers: ["top"],
    connectedTo: [`signal-${index}`],
  }))
  const connections: PreparedConnection[] = padPositions.map(
    (source, connectionIndex) => {
      const connection: SimpleRouteConnection = {
        name: `signal-${connectionIndex}`,
        pointsToConnect: [
          {
            ...source,
            layer: "top",
            pointId: `source-${connectionIndex}`,
            pcb_port_id: `port-${connectionIndex}`,
          },
          {
            x: connectionIndex < 2 ? -3 : 3,
            y: source.y,
            layer: "inner1",
            pointId: `target-${connectionIndex}`,
          },
        ],
      }
      return {
        connection,
        connectionIndex,
        sourcePoint: connection.pointsToConnect[0]!,
        sourcePointIndex: 0,
        sourceLayer: "top",
        sourceObstacle: obstacles[connectionIndex]!,
        targetPoint: connection.pointsToConnect[1]!,
      }
    },
  )
  const commonBusFields = {
    termination: { type: "boundary" as const },
    componentId: "U1",
    componentObstacles: obstacles,
    componentBounds: { minX: -0.3, maxX: 1.3, minY: -0.3, maxY: 1.3 },
    sharedBoundary: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    xCoordinates: [0, 1],
    yCoordinates: [0, 1],
    pitchX: 1,
    pitchY: 1,
  }
  return {
    buses: [
      {
        ...commonBusFields,
        busId: "left-bus",
        direction: "left",
        connections: connections.slice(0, 2),
      },
      {
        ...commonBusFields,
        busId: "right-bus",
        direction: "right",
        connections: connections.slice(2),
      },
    ],
    obstacles,
    connections,
  }
}

test("component-wide dogbone matching assigns deterministic legal interstitial vias", () => {
  const fixture = createFixture()
  const rules = {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.2,
    traceWidth: 0.1,
    clearance: 0.1,
    holeToHoleClearance: 0.3,
    maximumSearchStates: 1_000,
  }
  const matching = matchComponentDogboneViaSites(fixture.buses, rules)
  expect(matching).not.toBeNull()
  expect(matching!.size).toBe(4)

  const reversedFixture = createFixture()
  const reversedBuses = reversedFixture.buses
    .toReversed()
    .map((bus) => ({ ...bus, connections: bus.connections.toReversed() }))
  const reversedMatching = matchComponentDogboneViaSites(reversedBuses, rules)
  expect([...reversedMatching!.entries()]).toEqual([...matching!.entries()])

  const halfPitchCoordinates = [-0.5, 0.5, 1.5]
  for (const [connectionIndex, viaPoint] of matching!) {
    const preparedConnection = fixture.connections[connectionIndex]!
    const deltaX = Math.abs(viaPoint.x - preparedConnection.sourcePoint.x)
    const deltaY = Math.abs(viaPoint.y - preparedConnection.sourcePoint.y)
    expect(deltaX === 0 || deltaY === 0 || deltaX === deltaY).toBe(true)
    expect(halfPitchCoordinates).toContain(viaPoint.x)
    expect(halfPitchCoordinates).toContain(viaPoint.y)
    for (const obstacle of fixture.obstacles) {
      expect(
        distancePointToObstacle(viaPoint, obstacle),
      ).toBeGreaterThanOrEqual(rules.viaDiameter / 2 + rules.clearance - 1e-9)
    }
  }

  const assignments = [...matching!.entries()]
  for (let firstIndex = 0; firstIndex < assignments.length; firstIndex++) {
    const [firstConnectionIndex, firstPoint] = assignments[firstIndex]!
    const firstConnection = fixture.connections[firstConnectionIndex]!
    const firstSegment: RoutedSegment = {
      start: firstConnection.sourcePoint,
      end: firstPoint,
      width: rules.traceWidth,
      layer: firstConnection.sourceLayer,
    }
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < assignments.length;
      secondIndex++
    ) {
      const [secondConnectionIndex, secondPoint] = assignments[secondIndex]!
      const secondConnection = fixture.connections[secondConnectionIndex]!
      const secondSegment: RoutedSegment = {
        start: secondConnection.sourcePoint,
        end: secondPoint,
        width: rules.traceWidth,
        layer: secondConnection.sourceLayer,
      }
      expect(distance(firstPoint, secondPoint)).toBeGreaterThanOrEqual(0.5)
      expect(
        segmentsAreClear(firstSegment, secondSegment, rules.clearance),
      ).toBe(true)
    }
  }
})

test("component-wide dogbone matching fails within geometry and search bounds", () => {
  const fixture = createFixture()
  expect(
    matchComponentDogboneViaSites(fixture.buses, {
      viaDiameter: 0.5,
      traceWidth: 0.1,
      clearance: 0.1,
    }),
  ).toBeNull()
  expect(
    matchComponentDogboneViaSites(fixture.buses, {
      viaDiameter: 0.3,
      traceWidth: 0.1,
      clearance: 0.1,
      maximumSearchStates: 1,
    }),
  ).toBeNull()
})
