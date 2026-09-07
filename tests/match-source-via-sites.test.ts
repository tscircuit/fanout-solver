import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { getComponentDogboneViaSiteCandidates } from "../lib/match-component-dogbone-via-sites"
import {
  matchSourceViaSites,
  type SourceViaSiteFailure,
} from "../lib/match-source-via-sites"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import type { Point2D, PreparedBus, PreparedConnection } from "../lib/types"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"
import "bun-match-svg"

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

test("propagates fixed via conflicts across a complete source field", async () => {
  const fixture = createFixture()
  const before = JSON.stringify(fixture)
  const fixed = { x: 0.5, y: 0.5 }
  const rules = {
    viaDiameter: 0.3,
    viaHoleDiameter: 0.2,
    traceWidth: 0.1,
    clearance: 0.1,
    holeToHoleClearance: 0.3,
    maximumSearchStates: 1000,
    fixedViaPointsByConnectionIndex: new Map([[0, fixed]]),
  }
  const result = matchSourceViaSites(fixture.buses, rules)
  expect(result).not.toBeNull()
  expect(result!.size).toBe(4)
  expect(result!.get(0)).toEqual(fixed)
  expect(JSON.stringify(fixture)).toBe(before)
  expect(rules.fixedViaPointsByConnectionIndex.get(0)).toBe(fixed)
  const reversed = fixture.buses
    .toReversed()
    .map((b) => ({ ...b, connections: b.connections.toReversed() }))
  expect([...matchSourceViaSites(reversed, rules)!]).toEqual([...result!])
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    bounds: fixture.buses[0]!.sharedBoundary,
    obstacles: fixture.obstacles,
    connections: fixture.connections.map((c) => c.connection),
  }
  const plans = fixture.buses.flatMap((bus) =>
    bus.connections.map((connection) => {
      const point = result!.get(connection.connectionIndex)!
      return buildViaMinimalWindingPlan({
        ...rules,
        bus,
        terminal: { connection, viaPoint: point, exitPoint: point },
        targetLayer: "inner1",
        layerNames: ["top", "inner1", "inner2", "bottom"],
        allowBlindAndBuriedVias: false,
        sourceEscapePoints: [connection.sourcePoint, point],
        targetLayerPoints: [point, point],
      })
    }),
  )
  const drc = validateRoutedCopperDrc({
    inputSrj: srj,
    routedSrj: { ...srj, traces: plans.map((p) => p.trace) },
    clearance: rules.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc.valid).toBe(true)
  expect(drc.checkedTraceCount).toBe(4)
  expect(drc.checkedViaCount).toBe(4)
  // Every pad can use this interstice in isolation, but it cannot be shared by
  // two unrelated through-vias. The constraint solver must reject the field.
  for (const id of [0, 1])
    expect(
      getComponentDogboneViaSiteCandidates(fixture.buses, {
        ...rules,
        fixedViaPointsByConnectionIndex: new Map([[id, fixed]]),
      }).some(
        (c) =>
          c.connectionIndex === id &&
          c.point.x === fixed.x &&
          c.point.y === fixed.y,
      ),
    ).toBe(true)
  const failures: SourceViaSiteFailure[] = []
  expect(
    matchSourceViaSites(
      fixture.buses,
      {
        ...rules,
        maximumSearchStates: 1,
        fixedViaPointsByConnectionIndex: new Map([
          [0, fixed],
          [1, fixed],
        ]),
      },
      (failure) => failures.push(failure),
    ),
  ).toBeNull()
  expect(failures).toHaveLength(1)
  expect(failures[0]!.kind).toBe("incompatible-domains")
  expect([...failures[0]!.connectionIndices].sort()).toEqual([0, 1])
  failures.length = 0
  expect(
    matchSourceViaSites(
      fixture.buses,
      {
        ...rules,
        fixedViaPointsByConnectionIndex: new Map([[0, { x: 0, y: 0 }]]),
      },
      (failure) => failures.push(failure),
    ),
  ).toBeNull()
  expect(failures).toEqual([{ kind: "empty-domains", connectionIndices: [0] }])
  expect([
    ...matchSourceViaSites(fixture.buses, {
      ...rules,
      maximumSearchStates: 1,
      fixedViaPointsByConnectionIndex: result!,
    })!,
  ]).toEqual([...result!])
  for (const maximumSearchStates of [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(() =>
      matchSourceViaSites(fixture.buses, { ...rules, maximumSearchStates }),
    ).toThrow("positive safe-integer search budget")
  const svg = getSvgFromGraphicsObject(
    visualizeSimpleRouteJson({
      ...srj,
      connections: [],
      traces: plans.map((p) => p.trace),
    }),
  )
  expect(svg).toMatchSvgSnapshot(import.meta.path)
})
