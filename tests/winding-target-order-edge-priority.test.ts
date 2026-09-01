import { expect, test } from "bun:test"
import { getWindingTargetOrders } from "lib/route-bus"
import type { PreparedBus, PreparedConnection } from "lib/types"

const createBus = (targetLayers: readonly string[]): PreparedBus => {
  const connections = targetLayers.map(
    (layer, connectionIndex) =>
      ({
        connectionIndex,
        connection: {
          name: `signal-${connectionIndex}`,
          pointsToConnect: [],
        },
        sourcePoint: { x: connectionIndex, y: connectionIndex },
        sourceLayer: "top",
        targetPoint: { x: 8, y: connectionIndex, layer },
        exitTargetPoint: { x: 10, y: connectionIndex, layer },
        hasExplicitLayeredExitTarget: true,
      }) as unknown as PreparedConnection,
  )
  return {
    busId: "mixed-layer-corner-bus",
    componentId: "component",
    direction: "up",
    exitEdge: "right",
    preferredExit: "top-right",
    termination: { type: "boundary" },
    connections,
  } as PreparedBus
}

const indexes = (order: readonly PreparedConnection[]): number[] =>
  order.map((connection) => connection.connectionIndex)

test("does not add unsafe reflected orders to mixed-layer winding", () => {
  const bus = createBus(["inner1", "inner2", "inner1", "inner2"])
  const ordersByDirection = ["right", "up", "left"].map((direction) =>
    getWindingTargetOrders({
      bus,
      boundaryDirection: direction as "right" | "up" | "left",
      layerNames: ["top", "inner1", "inner2", "bottom"],
      targetLayer: "inner1",
    }).orders.map(indexes),
  )

  expect(ordersByDirection).toEqual(
    Array.from({ length: 3 }, () => [
      [0, 1, 2, 3],
      [1, 0, 2, 3],
      [0, 2, 1, 3],
      [0, 1, 3, 2],
    ]),
  )
})

test("keeps a reflected fallback for eastbound single-layer winding", () => {
  const bus = createBus(["inner1", "inner1", "inner1", "inner1"])
  const eastOrders = getWindingTargetOrders({
    bus,
    boundaryDirection: "right",
    layerNames: ["top", "inner1", "bottom"],
    targetLayer: "inner1",
  }).orders.map(indexes)

  expect(eastOrders.slice(0, 2)).toEqual([
    [0, 1, 2, 3],
    [3, 2, 1, 0],
  ])
})

test("promotes the reflected embedding for westbound single-layer winding", () => {
  const bus = createBus(["inner1", "inner1", "inner1", "inner1"])
  const westOrders = getWindingTargetOrders({
    bus,
    boundaryDirection: "left",
    layerNames: ["top", "inner1", "bottom"],
    targetLayer: "inner1",
  }).orders.map(indexes)

  expect(westOrders.slice(0, 2)).toEqual([
    [0, 1, 2, 3],
    [3, 2, 1, 0],
  ])
})
