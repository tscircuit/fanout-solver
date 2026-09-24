import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { prepareFanoutBuses } from "lib/prepare-buses"
import {
  routeBus,
  type RouteBusParams,
  type RouteBusStaticClearanceCache,
} from "lib/route-bus"

test("clearing route results rebuilds obstacle bounds after geometry changes", () => {
  const bounds = { minX: -1, maxX: 3, minY: -1, maxY: 1 }
  const srj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds,
    obstacles: [
      {
        obstacleId: "pad",
        componentId: "U1",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: ["SIG"],
      },
    ],
    connections: [
      {
        name: "SIG",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
    ],
  }
  const [bus] = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "signal",
        connectionNames: ["SIG"],
        sourceComponentId: "U1",
        direction: "right",
      },
    ],
  })
  const staticClearanceCache: RouteBusStaticClearanceCache = new Map()
  const params: RouteBusParams = {
    srj,
    bus: bus!,
    targetLayer: "top",
    acceptedPlans: [],
    layerNames: ["top", "bottom"],
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    compactBusTracks: true,
    staticClearanceCache,
  }
  expect(routeBus(params)).toHaveLength(1)
  expect(staticClearanceCache.size).toBeGreaterThan(0)
  // Mutate the same obstacle array, then explicitly invalidate result caching.
  srj.obstacles.push({
    type: "rect",
    center: { x: 2, y: 0 },
    width: 0.5,
    height: 10,
    layers: ["top", "bottom"],
    connectedTo: [],
  })
  staticClearanceCache.clear()
  expect(routeBus(params)).toBeNull()
  srj.obstacles.pop()
  staticClearanceCache.clear()
  expect(routeBus(params)).toHaveLength(1)
})
