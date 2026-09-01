import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  segmentsAreClear,
} from "lib/geometry"
import {
  getComponentDogboneViaPathCandidates,
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaPaths,
  matchComponentDogboneViaSites,
} from "lib/match-component-dogbone-via-sites"
import type {
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "lib/types"

const EPSILON = 1e-9

function createSinglePlaneFixture(): {
  bus: PreparedBus
  connection: PreparedConnection
  sourceObstacle: Obstacle
} {
  const sourceObstacle: Obstacle = {
    obstacleId: "source-pad",
    componentId: "U1",
    type: "rect",
    center: { x: 0, y: 0 },
    width: 0.6,
    height: 0.6,
    layers: ["top"],
    connectedTo: ["signal-0"],
  }
  const simpleConnection: SimpleRouteConnection = {
    name: "signal-0",
    pointsToConnect: [
      {
        x: 0,
        y: 0,
        layer: "top",
        pointId: "source-0",
        pcb_port_id: "port-0",
      },
      {
        x: 0,
        y: 0,
        layer: "inner1",
        pointId: "plane-0",
      },
    ],
  }
  const connection: PreparedConnection = {
    connection: simpleConnection,
    connectionIndex: 0,
    sourcePoint: simpleConnection.pointsToConnect[0]!,
    sourcePointIndex: 0,
    sourceLayer: "top",
    sourceObstacle,
    targetPoint: simpleConnection.pointsToConnect[1]!,
  }
  return {
    connection,
    sourceObstacle,
    bus: {
      busId: "plane-bus",
      termination: { type: "plane", layer: "inner1" },
      direction: "right",
      componentId: "U1",
      componentObstacles: [sourceObstacle],
      componentBounds: { minX: -0.3, maxX: 0.3, minY: -0.3, maxY: 0.3 },
      sharedBoundary: { minX: -4, maxX: 4, minY: -4, maxY: 4 },
      xCoordinates: [0],
      yCoordinates: [0],
      pitchX: 1,
      pitchY: 1,
      connections: [connection],
    },
  }
}

function getTurnDegrees(
  firstStart: Point2D,
  corner: Point2D,
  secondEnd: Point2D,
): number {
  const first = Math.atan2(corner.y - firstStart.y, corner.x - firstStart.x)
  const second = Math.atan2(secondEnd.y - corner.y, secondEnd.x - corner.x)
  let turn = Math.abs(((second - first) * 180) / Math.PI)
  while (turn >= 360) turn -= 360
  return Math.min(turn, 360 - turn)
}

function expectOctilinearWithoutRightAngles(path: readonly Point2D[]): void {
  for (let index = 1; index < path.length; index++) {
    const deltaX = Math.abs(path[index]!.x - path[index - 1]!.x)
    const deltaY = Math.abs(path[index]!.y - path[index - 1]!.y)
    expect(
      deltaX <= EPSILON ||
        deltaY <= EPSILON ||
        Math.abs(deltaX - deltaY) <= EPSILON,
    ).toBe(true)
  }
  for (let index = 1; index + 1 < path.length; index++) {
    const turn = getTurnDegrees(
      path[index - 1]!,
      path[index]!,
      path[index + 1]!,
    )
    expect(turn).toBeLessThan(90 - EPSILON)
  }
}

test("path-aware plane matching adaptively reaches a clear channel via", () => {
  const fixture = createSinglePlaneFixture()
  const blockedBaseSites: Point2D[] = [
    { x: -0.5, y: -0.5 },
    { x: -0.5, y: 0.5 },
    { x: 0.5, y: -0.5 },
    { x: 0.5, y: 0.5 },
    { x: -1.5, y: -0.5 },
    { x: -1.5, y: 0.5 },
    { x: 1.5, y: -0.5 },
    { x: 1.5, y: 0.5 },
    { x: -0.5, y: -1.5 },
    { x: 0.5, y: -1.5 },
    { x: -0.5, y: 1.5 },
    { x: 0.5, y: 1.5 },
  ]
  const bottomObstacles: Obstacle[] = blockedBaseSites.map((center, index) => ({
    obstacleId: `bottom-blocker-${index}`,
    componentId: `C${index}`,
    type: "rect",
    center,
    width: 0.02,
    height: 0.02,
    layers: ["bottom"],
    connectedTo: [`other-${index}`],
  }))
  const rules = {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
    holeToHoleClearance: 0.1,
    maximumSearchStates: 20_000,
    blockingObstacles: bottomObstacles,
    planePathOptions: {
      bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
      maximumDiagnosticSearchStates: 1_000,
    },
  }

  expect(
    getComponentDogboneViaSiteCandidates(
      [
        {
          ...fixture.bus,
          componentObstacles: [fixture.sourceObstacle, ...bottomObstacles],
        },
      ],
      rules,
    ),
  ).toHaveLength(0)

  const matching = matchComponentDogboneViaPaths([fixture.bus], rules)
  expect(matching).not.toBeNull()
  const selected = matching!.get(0)!
  expect(selected.path.length).toBeGreaterThanOrEqual(3)
  expect(selected.path.at(-1)).toEqual(selected.point)
  expectOctilinearWithoutRightAngles(selected.path)
  for (const obstacle of bottomObstacles) {
    expect(
      distancePointToObstacle(selected.point, obstacle),
    ).toBeGreaterThanOrEqual(rules.viaDiameter / 2 + rules.clearance - EPSILON)
  }

  const reversed = matchComponentDogboneViaPaths(
    [{ ...fixture.bus, connections: fixture.bus.connections.toReversed() }],
    rules,
  )
  expect(reversed).toEqual(matching)
})

test("path-aware candidates honor via span and source-layer blocking", () => {
  const fixture = createSinglePlaneFixture()
  const candidates = getComponentDogboneViaPathCandidates([fixture.bus], {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
    blockingObstacles: [
      {
        obstacleId: "bottom-via-blocker",
        componentId: "C1",
        type: "rect",
        center: { x: -0.5, y: -0.5 },
        width: 0.02,
        height: 0.02,
        layers: ["bottom"],
        connectedTo: ["other"],
      },
    ],
    blockingSegments: [
      {
        connectionIndex: 10,
        segment: {
          start: { x: 0.2, y: 0.2 },
          end: { x: 0.8, y: 0.8 },
          width: 0.1,
          layer: "bottom",
        },
      },
      {
        connectionIndex: 11,
        segment: {
          start: { x: -0.8, y: 0.8 },
          end: { x: -0.2, y: 0.2 },
          width: 0.1,
          layer: "top",
        },
      },
    ],
  })
  expect(candidates.length).toBeGreaterThan(0)
  expect(
    candidates.some(
      (candidate) => distance(candidate.point, { x: -0.5, y: -0.5 }) <= EPSILON,
    ),
  ).toBe(false)
  expect(
    candidates.some((candidate) =>
      candidate.path.some(
        (point) => distance(point, { x: 0.5, y: 0.5 }) <= EPSILON,
      ),
    ),
  ).toBe(true)
  expect(
    candidates.some((candidate) =>
      candidate.path.some(
        (point) => distance(point, { x: -0.5, y: 0.5 }) <= EPSILON,
      ),
    ),
  ).toBe(false)
})

test("blocking copper rejects path candidates before global obstacle scans", () => {
  const fixture = createSinglePlaneFixture()
  let globalObstacleCheckCount = 0
  const candidates = getComponentDogboneViaPathCandidates([fixture.bus], {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
    blockingSegments: [
      {
        connectionIndex: 10,
        segment: {
          start: { x: -10, y: 0 },
          end: { x: 10, y: 0 },
          width: 20,
          layer: "top",
        },
      },
    ],
    blockingObstacles: [
      {
        obstacleId: "unreached-global-obstacle",
        componentId: "C1",
        type: "rect",
        center: { x: 100, y: 100 },
        width: 0.1,
        height: 0.1,
        layers: ["bottom"],
        connectedTo: ["other"],
      },
    ],
    obstacleCanBeIgnored: () => {
      globalObstacleCheckCount++
      return false
    },
  })

  expect(candidates).toEqual([])
  expect(globalObstacleCheckCount).toBe(0)
})

test("path-aware matching enforces mutual via, trace, and path clearances", () => {
  const firstFixture = createSinglePlaneFixture()
  const secondFixture = createSinglePlaneFixture()
  const secondSource = { x: 1, y: 0 }
  secondFixture.connection.connectionIndex = 1
  secondFixture.connection.connection.name = "signal-1"
  Object.assign(secondFixture.connection.sourcePoint, secondSource)
  Object.assign(secondFixture.connection.sourceObstacle.center, secondSource)
  secondFixture.bus = {
    ...secondFixture.bus,
    busId: "second-plane-bus",
    xCoordinates: [1],
    componentId: "U2",
    componentObstacles: [secondFixture.sourceObstacle],
    connections: [secondFixture.connection],
  }
  secondFixture.sourceObstacle.componentId = "U2"

  const rules = {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
    maximumSearchStates: 10_000,
  }
  const matching = matchComponentDogboneViaPaths(
    [firstFixture.bus, secondFixture.bus],
    rules,
  )
  expect(matching).not.toBeNull()
  const first = matching!.get(0)!
  const second = matching!.get(1)!
  expect(distance(first.point, second.point)).toBeGreaterThanOrEqual(
    rules.viaDiameter + rules.clearance - EPSILON,
  )
  const firstSegments: RoutedSegment[] = first.path
    .slice(1)
    .map((end, index) => ({
      start: first.path[index]!,
      end,
      width: rules.traceWidth,
      layer: "top",
    }))
  const secondSegments: RoutedSegment[] = second.path
    .slice(1)
    .map((end, index) => ({
      start: second.path[index]!,
      end,
      width: rules.traceWidth,
      layer: "top",
    }))
  for (const segment of secondSegments) {
    expect(
      distancePointToSegment(first.point, segment.start, segment.end),
    ).toBeGreaterThanOrEqual(
      rules.viaDiameter / 2 + rules.traceWidth / 2 + rules.clearance - EPSILON,
    )
  }
  for (const segment of firstSegments) {
    expect(
      distancePointToSegment(second.point, segment.start, segment.end),
    ).toBeGreaterThanOrEqual(
      rules.viaDiameter / 2 + rules.traceWidth / 2 + rules.clearance - EPSILON,
    )
  }
  for (const firstSegment of firstSegments) {
    for (const secondSegment of secondSegments) {
      expect(
        segmentsAreClear(firstSegment, secondSegment, rules.clearance),
      ).toBe(true)
    }
  }
})

test("path-aware matching prefers a complete direct assignment before channel escapes", () => {
  const sourcePoints = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ]
  const fixtures = sourcePoints.map((sourcePoint, connectionIndex) => {
    const fixture = createSinglePlaneFixture()
    fixture.connection.connectionIndex = connectionIndex
    fixture.connection.connection.name = `signal-${connectionIndex}`
    fixture.connection.sourceObstacle.obstacleId = `source-pad-${connectionIndex}`
    fixture.connection.sourceObstacle.connectedTo = [
      `signal-${connectionIndex}`,
    ]
    fixture.connection.sourceObstacle.width = 0.4
    fixture.connection.sourceObstacle.height = 0.4
    Object.assign(fixture.connection.sourcePoint, sourcePoint)
    Object.assign(fixture.connection.targetPoint, sourcePoint)
    Object.assign(fixture.connection.sourceObstacle.center, sourcePoint)
    return fixture
  })
  const bus: PreparedBus = {
    ...fixtures[0]!.bus,
    componentObstacles: fixtures.map((fixture) => fixture.sourceObstacle),
    componentBounds: { minX: -0.3, maxX: 1.3, minY: -0.3, maxY: 1.3 },
    xCoordinates: [0, 1],
    yCoordinates: [0, 1],
    connections: fixtures.map((fixture) => fixture.connection),
  }
  const rules = {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.2,
    maximumSearchStates: 100_000,
  }

  const directMatching = matchComponentDogboneViaSites([bus], rules)
  expect(directMatching).not.toBeNull()

  const pathMatching = matchComponentDogboneViaPaths([bus], {
    ...rules,
    planePathOptions: {
      channelConnectionIndexes: new Set([0, 1, 2, 3]),
      maximumChannelRing: 2,
      maximumChannelCandidatesPerConnection: 12,
    },
  })
  expect(pathMatching).not.toBeNull()
  expect(
    [...pathMatching!.values()].map((assignment) => assignment.path.length),
  ).toEqual([2, 2, 2, 2])
})

test("path-aware matching consumes the caller's aggregate search budget", () => {
  const fixture = createSinglePlaneFixture()
  const expandedStateBudget = { remaining: 1, exhausted: false }
  const matching = matchComponentDogboneViaPaths([fixture.bus], {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
    maximumSearchStates: 100_000,
    expandedStateBudget,
  })

  expect(matching).toBeNull()
  expect(expandedStateBudget).toEqual({ remaining: 0, exhausted: true })
})

test("channel retention fills unused topology-reservation slots with new endpoints", () => {
  const fixture = createSinglePlaneFixture()
  const blocker: Obstacle = {
    obstacleId: "channel-centerline-blocker",
    componentId: "C1",
    type: "rect",
    center: { x: -0.5, y: 0 },
    width: 0.02,
    height: 0.02,
    layers: ["top"],
    connectedTo: ["other"],
  }
  const rules = {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
    blockingObstacles: [blocker],
  }
  const ordinary = getComponentDogboneViaPathCandidates([fixture.bus], rules)
  const expanded = getComponentDogboneViaPathCandidates([fixture.bus], {
    ...rules,
    planePathOptions: {
      channelConnectionIndexes: new Set([0]),
      maximumChannelRing: 2,
      maximumChannelCandidatesPerConnection: 3,
    },
  })
  const ordinaryPaths = new Set(
    ordinary.map((candidate) => JSON.stringify(candidate.path)),
  )
  const channelCandidates = expanded.filter(
    (candidate) => !ordinaryPaths.has(JSON.stringify(candidate.path)),
  )

  expect(channelCandidates).toHaveLength(3)
  expect(channelCandidates.map((candidate) => candidate.point)).toEqual([
    { x: -1, y: -0.5 },
    { x: -1, y: 0.5 },
    { x: -0.5, y: -1 },
  ])
})

test("channel retention keeps shifted bends with the same direction sequence", () => {
  const fixture = createSinglePlaneFixture()
  const blockers: Obstacle[] = [
    {
      obstacleId: "upper-channel-blocker",
      componentId: "C1",
      type: "rect",
      center: { x: -0.25, y: -0.25 },
      width: 0.02,
      height: 0.02,
      layers: ["top"],
      connectedTo: ["other-upper"],
    },
    {
      obstacleId: "lower-channel-blocker",
      componentId: "C2",
      type: "rect",
      center: { x: -0.25, y: -1.75 },
      width: 0.02,
      height: 0.02,
      layers: ["top"],
      connectedTo: ["other-lower"],
    },
  ]
  const candidates = getComponentDogboneViaPathCandidates([fixture.bus], {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
    blockingObstacles: blockers,
    preferredViaPointsByConnectionIndex: new Map([[0, { x: -0.5, y: -2 }]]),
    planePathOptions: {
      channelConnectionIndexes: new Set([0]),
      maximumChannelRing: 3,
      maximumChannelCandidatesPerConnection: 3,
      bounds: { minX: -0.5, maxX: 0, minY: -2, maxY: 0 },
    },
  })
  const paths = candidates.map((candidate) => candidate.path)

  expect(paths).toContainEqual([
    { x: 0, y: 0 },
    { x: 0, y: -0.5 },
    { x: -0.5, y: -1 },
    { x: -0.5, y: -2 },
  ])
  expect(paths).toContainEqual([
    { x: 0, y: 0 },
    { x: 0, y: -1 },
    { x: -0.5, y: -1.5 },
    { x: -0.5, y: -2 },
  ])
})
