import { expect, test } from "bun:test"
import {
  getBoundaryTargetTrack,
  getPrioritizedSourceTopologyConnectionOrders,
  getWindingTargetOrders,
} from "lib/route-bus"
import type { Point2D, PreparedBus, PreparedConnection } from "lib/types"

const sourcePoints: Point2D[] = [
  { x: -2, y: -3 },
  { x: 2, y: 1 },
  { x: -1, y: -1 },
  { x: 1, y: 3 },
]
const targetTracks = [-3, -1, 1, 3]

function createBus(
  targetLayers: readonly string[] = ["inner1", "inner1", "inner1", "inner1"],
): PreparedBus {
  const connections = sourcePoints.map(
    (sourcePoint, connectionIndex): PreparedConnection =>
      ({
        connectionIndex,
        connection: {
          // The deliberately scrambled identities ensure these expectations
          // come from geometry, not lexical bus or signal naming.
          name: ["zeta", "alpha", "mu", "beta"][connectionIndex]!,
          pointsToConnect: [],
        },
        sourcePoint,
        sourceLayer: "top",
        targetPoint: {
          x: -8,
          y: targetTracks[connectionIndex]!,
          layer: targetLayers[connectionIndex]!,
        },
        exitTargetPoint: {
          x: -10,
          y: targetTracks[connectionIndex]!,
          layer: targetLayers[connectionIndex]!,
        },
        hasExplicitLayeredExitTarget: true,
      }) as unknown as PreparedConnection,
  )
  return {
    busId: "opaque-bus",
    componentId: "opaque-component",
    direction: "left",
    exitEdge: "left",
    preferredExit: "left",
    termination: { type: "boundary" },
    sharedBoundary: { minX: -6, maxX: 6, minY: -6, maxY: 6 },
    connections,
  } as PreparedBus
}

const connectionIndexes = (
  order: readonly PreparedConnection[] | undefined,
): number[] => order?.map(({ connectionIndex }) => connectionIndex) ?? []

test("prioritized source topology reflects with the escape direction", () => {
  const bus = createBus()
  const westOrders = getPrioritizedSourceTopologyConnectionOrders(bus, "left")
  const eastOrders = getPrioritizedSourceTopologyConnectionOrders(bus, "right")

  expect(connectionIndexes(westOrders[0])).toEqual([3, 1, 2, 0])
  expect(connectionIndexes(eastOrders[0])).toEqual([0, 2, 1, 3])

  const translatedBus = {
    ...bus,
    connections: bus.connections.map((connection) => ({
      ...connection,
      sourcePoint: {
        x: connection.sourcePoint.x + 100,
        y: connection.sourcePoint.y - 40,
      },
    })),
  } as PreparedBus
  expect(
    connectionIndexes(
      getPrioritizedSourceTopologyConnectionOrders(translatedBus, "left")[0],
    ),
  ).toEqual(connectionIndexes(westOrders[0]))
})

test("single-layer winding reuses lane slots without mutating explicit targets", () => {
  const bus = createBus()
  const requestedTargets = bus.connections.map(({ exitTargetPoint }) => ({
    ...exitTargetPoint!,
  }))

  // For a single target layer the source-topology orders are inserted directly
  // after the canonical and reflected target orders. Index 2 is therefore the
  // preferred source-topology embedding for this four-lane westbound bus.
  const assignedTracks = new Map(
    bus.connections.map((connection) => [
      connection.connectionIndex,
      getBoundaryTargetTrack({
        bus,
        connection,
        boundaryDirection: "left",
        layerNames: ["top", "inner1", "bottom"],
        targetLayer: "inner1",
        windingOrderIndex: 2,
      }),
    ]),
  )
  expect(assignedTracks).toEqual(
    new Map([
      [0, 3],
      [1, -1],
      [2, 1],
      [3, -3],
    ]),
  )
  expect(bus.connections.map(({ exitTargetPoint }) => exitTargetPoint)).toEqual(
    requestedTargets,
  )

  const mixedLayerBus = createBus(["inner1", "inner1", "inner1", "inner2"])
  expect(
    getBoundaryTargetTrack({
      bus: mixedLayerBus,
      connection: mixedLayerBus.connections[3]!,
      boundaryDirection: "left",
      layerNames: ["top", "inner1", "inner2", "bottom"],
      targetLayer: "inner1",
      windingOrderIndex: 2,
    }),
  ).toBe(3)
})

test("downbound single-layer winding includes the source-topology target order", () => {
  const bus = createBus()
  const downboundBus = {
    ...bus,
    direction: "down",
    exitEdge: "bottom",
    preferredExit: "bottom",
    connections: bus.connections.map((connection, connectionIndex) => ({
      ...connection,
      targetPoint: {
        x: targetTracks[connectionIndex]!,
        y: -8,
        layer: "inner1",
      },
      exitTargetPoint: {
        x: targetTracks[connectionIndex]!,
        y: -10,
        layer: "inner1",
      },
    })),
  } as PreparedBus
  const prioritizedSourceOrder = getPrioritizedSourceTopologyConnectionOrders(
    downboundBus,
    "down",
  )[0]
  const windingOrders = getWindingTargetOrders({
    bus: downboundBus,
    boundaryDirection: "down",
    layerNames: ["top", "inner1", "bottom"],
    targetLayer: "inner1",
  }).orders

  expect(connectionIndexes(windingOrders[2])).toEqual(
    connectionIndexes(prioritizedSourceOrder),
  )
  expect(connectionIndexes(windingOrders[2])).toEqual([1, 3, 2, 0])
})
