import "bun-match-svg"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { buildViaMinimalWindingPlan } from "../../lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "../../lib/types"

export function createNarrowMeanderFixture() {
  const width = 0.08128
  const clearance = width
  const boundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const layerNames = ["top", "inner1", "bottom"]
  const points = [
    { x: 0.325, y: 4.125 },
    { x: 2.325, y: 4.125 },
  ]
  const pads = points.map((center, i) => ({
    type: "rect" as const,
    shape: "circle" as const,
    center,
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`data-${i}`],
  }))
  const connections = points.map((p, i) => ({
    name: `data-${i}`,
    pointsToConnect: [
      { ...p, layer: "top", pointId: `pad-${i}` },
      { x: i * 2, y: -6, layer: "bottom", pointId: `target-${i}` },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: width,
    bounds: boundary,
    connections,
    obstacles: [
      ...pads,
      ...[-1, 1].map((sign) => ({
        type: "rect" as const,
        center: { x: sign * 0.32128, y: -0.475 },
        width,
        height: 8.35,
        layers: ["bottom"],
        connectedTo: [`wall-${sign}`],
      })),
    ],
  }
  const prepared: PreparedConnection[] = connections.map((connection, i) => ({
    connection,
    connectionIndex: i,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: pads[i]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const bus: PreparedBus = {
    busId: "DATA",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: 0.175, maxX: 2.475, minY: 3.975, maxY: 4.275 },
    sharedBoundary: boundary,
    xCoordinates: points.map((p) => p.x),
    yCoordinates: [4.125],
    pitchX: 2,
    pitchY: 2,
    direction: "down",
    exitEdge: "bottom",
    preferredExit: "bottom",
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    termination: { type: "boundary" },
    connections: prepared,
    maxLengthSkew: 0,
  }
  const base = {
    srj,
    bus,
    targetLayer: "bottom",
    acceptedPlans: [],
    traceWidth: width,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames,
    allowBlindAndBuriedVias: false,
  }
  const routes = [
    [
      { x: 0, y: 3.8 },
      { x: 0, y: -5 },
    ],
    [
      { x: 2, y: 3.8 },
      { x: 4.2, y: 3.8 },
      { x: 4.4, y: 3.6 },
      { x: 4.4, y: -4.4 },
      { x: 4.2, y: -4.6 },
      { x: 2.2, y: -4.6 },
      { x: 2, y: -4.8 },
      { x: 2, y: -5 },
    ],
  ]
  const plans = prepared.map((connection, i) =>
    buildViaMinimalWindingPlan({
      ...base,
      terminal: {
        connection,
        viaPoint: routes[i]![0]!,
        exitPoint: routes[i]!.at(-1)!,
      },
      sourceEscapePoints: [connection.sourcePoint, routes[i]![0]!],
      targetLayerPoints: routes[i]!,
    }),
  )
  bus.maxLengthSkew = plans[1]!.length - plans[0]!.length - 2.4
  const snapshot = JSON.stringify({ srj, bus, plans })
  const params = {
    plans,
    preparedBuses: [bus],
    inputSrj: srj,
    sharedBoundary: boundary,
    clearance,
    allowBlindAndBuriedVias: false,
    allowMatchingInsideDenseBounds: true,
  }
  const fragmented: SimpleRouteJson = {
    ...srj,
    obstacles: [
      ...srj.obstacles,
      ...[-1, 1].map((sign) => ({
        type: "rect" as const,
        center: { x: sign * 2 * width, y: 0 },
        width,
        height: 1,
        layers: ["bottom"],
        connectedTo: [`neck-${sign}`],
      })),
    ],
  }
  return {
    srj,
    bus,
    plans,
    params,
    prepared,
    boundary,
    layerNames,
    clearance,
    width,
    pads,
    snapshot,
    fragmented,
  }
}
