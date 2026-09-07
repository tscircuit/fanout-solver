import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { buildViaMinimalWindingPlan } from "../../lib/route-via-minimal-winding"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "../../lib/types"
export function makeDeclaredLayerBridgeFixture(twoBlocked = false) {
  const width = 0.1
  const clearance = 0.1
  const layerNames = ["top", "inner1", "bottom"]
  const boundary = { minX: -4, maxX: 4, minY: -4, maxY: 4 }
  const definitions = [
    { name: "DIRECT", x: -1, y: twoBlocked ? -1 : 1, targetY: 1.6 },
    { name: "BRIDGED", x: 1, y: -1, targetY: 2.6 },
    { name: "WALL", x: 3.7, y: 0, targetY: 0 },
  ]
  const pads = definitions.map((d, i) => ({
    type: "rect" as const,
    center: { x: d.x, y: d.y },
    width: i === 2 ? 0.6 : 0.3,
    height: 0.3,
    layers: [i === 2 ? "bottom" : "top"],
    componentId: i === 2 ? "U2" : "U1",
    connectedTo: [d.name],
  }))
  const connections = definitions.map((d, i) => ({
    name: d.name,
    pointsToConnect: [
      {
        ...pads[i]!.center,
        layer: pads[i]!.layers[0]!,
        pointId: `source-${i}`,
      },
      { x: -5, y: d.targetY, layer: "bottom", pointId: `target-${i}` },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: width,
    bounds: boundary,
    obstacles: pads,
    connections,
  }
  const prepared: PreparedConnection[] = connections.map((connection, i) => ({
    connection,
    connectionIndex: i,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: pads[i]!.layers[0]!,
    sourceObstacle: pads[i]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const base = {
    componentId: "U1",
    componentObstacles: pads.slice(0, 2),
    componentBounds: { minX: -1.15, maxX: 1.15, minY: -1.15, maxY: 1.15 },
    sharedBoundary: boundary,
    xCoordinates: [-1, 1],
    yCoordinates: [-1, 1],
    pitchX: 2,
    pitchY: 2,
    termination: { type: "boundary" as const },
  }
  const bus: PreparedBus = {
    ...base,
    busId: "DATA",
    connections: prepared.slice(0, 2),
    direction: "up",
    exitEdge: "left",
    preferredExit: "top-left",
    allowedLayers: ["inner1", "bottom"],
    routableEscapeLayers: ["inner1", "bottom"],
    maxLengthSkew: 5,
  }
  const wallBus: PreparedBus = {
    ...base,
    busId: "WALL",
    componentId: "U2",
    componentObstacles: [pads[2]!],
    componentBounds: { minX: 3.4, maxX: 4, minY: -0.15, maxY: 0.15 },
    connections: [prepared[2]!],
    direction: "left",
    exitEdge: "left",
    preferredExit: "left",
    allowedLayers: ["bottom"],
  }
  const wall: FanoutRoutePlan = {
    ...prepared[2]!,
    busId: "WALL",
    connectionName: "WALL",
    targetLayer: "bottom",
    direction: "left",
    exitEdge: "left",
    termination: { type: "boundary" },
    exitPoint: { x: -4, y: 0 },
    length: 7.7,
    segments: [
      {
        start: pads[2]!.center,
        end: { x: -4, y: 0 },
        width,
        layer: "bottom",
      },
    ],
    trace: {
      type: "pcb_trace",
      pcb_trace_id: "wall",
      connection_name: "WALL",
      route: [pads[2]!.center, { x: -4, y: 0 }].map((p) => ({
        route_type: "wire" as const,
        ...p,
        width,
        layer: "bottom",
      })),
    },
  }
  const sourceEscapes = bus.connections.map((c) => ({
    connectionIndex: c.connectionIndex,
    connectionName: c.connection.name,
    segments: [
      {
        start: c.sourcePoint,
        end: { x: c.sourcePoint.x + 0.35, y: c.sourcePoint.y + 0.35 },
        width,
        layer: "top",
      },
    ],
    via: {
      center: { x: c.sourcePoint.x + 0.35, y: c.sourcePoint.y + 0.35 },
      diameter: 0.24,
      holeDiameter: 0.1,
      spanLayers: layerNames,
      fromLayer: "top",
      toLayer: "bottom",
    },
  }))
  const terminals = bus.connections.map((connection, i) => ({
    connection,
    viaPoint: sourceEscapes[i]!.via.center,
    exitPoint: { x: -4, y: definitions[i]!.targetY },
  }))
  const params = {
    srj,
    bus,
    targetLayer: "bottom",
    terminals,
    sourceEscapes,
    sourceBoundary: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    acceptedPlans: [wall],
    traceWidth: width,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames,
    allowBlindAndBuriedVias: false,
    compactBusTracks: false,
  }
  const sourcePlans = terminals.map((terminal, i) =>
    buildViaMinimalWindingPlan({
      ...params,
      terminal: { ...terminal, exitPoint: terminal.viaPoint },
      sourceEscapePoints: [
        sourceEscapes[i]!.segments[0]!.start,
        terminal.viaPoint,
      ],
      targetLayerPoints: [terminal.viaPoint, terminal.viaPoint],
    }),
  )
  return {
    width,
    clearance,
    layerNames,
    boundary,
    srj,
    bus,
    wallBus,
    wall,
    sourceEscapes,
    terminals,
    params,
    sourcePlans,
  }
}
