import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distancePointToSegment } from "lib/geometry"
import { routeViaMinimalWindingAlternativesSteps } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"

test("same-layer cuts do not create virtual barrels and still respect reserved physical vias", () => {
  const boundary = { minX: -2, maxX: 0, minY: -0.8, maxY: 0.8 }
  const connections: PreparedConnection[] = [0, 0.08].map(
    (y, connectionIndex) => {
      const sourcePoint = { x: -0.5, y, layer: "bottom" },
        targetPoint = { x: -2, y, layer: "bottom" },
        name = `tail-${connectionIndex}`
      const sourceObstacle: Obstacle & { shape: "circle" } = {
        type: "rect",
        shape: "circle",
        center: sourcePoint,
        width: 0.02,
        height: 0.02,
        layers: ["bottom"],
        connectedTo: [name],
        componentId: "cut",
      }
      return {
        connection: { name, pointsToConnect: [sourcePoint, targetPoint] },
        connectionIndex,
        sourcePointIndex: 0,
        sourcePoint,
        sourceLayer: "bottom",
        sourceObstacle,
        targetPoint,
      }
    },
  )
  const bus: PreparedBus = {
    busId: "tails",
    direction: "left",
    exitEdge: "left",
    preferredExit: "left",
    componentId: "cut",
    componentObstacles: connections.map((c) => c.sourceObstacle),
    componentBounds: { minX: -0.51, maxX: -0.49, minY: -0.01, maxY: 0.09 },
    sharedBoundary: boundary,
    pitchX: 0.08,
    pitchY: 0.08,
    xCoordinates: [-0.5],
    yCoordinates: [0, 0.08],
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    connections,
  }
  const srj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.04,
    bounds: boundary,
    obstacles: connections.map((c) => c.sourceObstacle),
    connections: connections.map((c) => c.connection),
  }
  const reserved = {
    center: { x: -1.2, y: 0 },
    diameter: 0.2,
    spanLayers: ["top", "bottom"],
  }
  const steps = routeViaMinimalWindingAlternativesSteps({
    srj,
    bus,
    terminals: connections.map((connection) => ({
      connection,
      viaPoint: connection.sourcePoint,
      exitPoint: connection.targetPoint,
    })),
    targetLayer: "bottom",
    acceptedPlans: [],
    layerNames: ["top", "bottom"],
    traceWidth: 0.04,
    clearance: 0.04,
    viaDiameter: 0.2,
    viaHoleDiameter: 0.1,
    allowBlindAndBuriedVias: false,
    allowSourceLayerRouting: true,
    reservedVias: [{ connectionName: "future-source", via: reserved }],
    gridStep: 0.04,
    gridOrigin: { x: 0, y: 0 },
    gridStepDivisor: 2,
    alignGridToPads: true,
    maximumRouteOrderAttempts: 12,
    heuristicWeight: 2,
  })
  let next = steps.next()
  while (!next.done) next = steps.next()
  const plans = next.value[0]
  expect(plans).toHaveLength(2)
  if (!plans) throw new Error("Expected both path-only tails")
  for (const plan of plans) {
    expect(plan.via).toBeUndefined()
    expect(plan.additionalVias ?? []).toHaveLength(0)
    expect(plan.trace.route.some((p) => p.route_type === "via")).toBe(false)
    for (const s of plan.segments)
      expect(
        distancePointToSegment(reserved.center, s.start, s.end),
      ).toBeGreaterThanOrEqual(0.16 - 1e-7)
  }
})
