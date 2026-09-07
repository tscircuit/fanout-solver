import "bun-match-svg"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { matchSourceViaSites } from "../../lib/match-source-via-sites"
import { buildViaMinimalWindingPlan } from "../../lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "../../lib/types"

export function fixture() {
  const width = 0.08128
  const clearance = 0.08128
  const pitch = 0.65
  const coordinates = [-0.975, -0.325, 0.325, 0.975]
  const boundary = { minX: -2.2, maxX: 2.2, minY: -2.2, maxY: 2.2 }
  const layerNames = ["top", "inner1", "bottom"]
  const signalIds = [7, 5, 2]
  const pads = coordinates.flatMap((x, column) =>
    coordinates.map((y, row) => ({
      type: "rect" as const,
      shape: "circle" as const,
      center: { x, y },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      connectedTo: [
        row % 2 === 0 ? `C${column * 2 + row / 2}` : `unused-${column}-${row}`,
      ],
      componentId: "GRID",
    })),
  )
  const connected = pads.filter((_, index) => index % 2 === 0)
  const connections = connected.map((pad, index) => ({
    name: `C${index}`,
    pointsToConnect: [
      { ...pad.center, layer: "top", pointId: `source-${index}` },
      {
        x: [-1, 0, 1][signalIds.indexOf(index)] ?? pad.center.x,
        y: -3,
        layer: "inner1",
        pointId: `target-${index}`,
      },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: width,
    bounds: boundary,
    obstacles: pads,
    connections,
  }
  const prepared: PreparedConnection[] = connections.map(
    (connection, index) => ({
      connection,
      connectionIndex: index,
      sourcePointIndex: 0,
      sourcePoint: connection.pointsToConnect[0]!,
      sourceObstacle: connected[index]!,
      sourceLayer: "top",
      targetPoint: connection.pointsToConnect[1]!,
    }),
  )
  const common = {
    componentId: "GRID",
    componentObstacles: pads,
    componentBounds: { minX: -1.125, maxX: 1.125, minY: -1.125, maxY: 1.125 },
    xCoordinates: coordinates,
    yCoordinates: coordinates,
    pitchX: pitch,
    pitchY: pitch,
    sharedBoundary: boundary,
    direction: "down" as const,
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
  }
  const bus: PreparedBus = {
    ...common,
    busId: "ORDERED_SIGNALS",
    connections: prepared.filter((c) => signalIds.includes(c.connectionIndex)),
    termination: { type: "boundary" },
    exitEdge: "bottom",
    preferredExit: "bottom",
  }
  const plane: PreparedBus = {
    ...common,
    busId: "PLANE_SOURCES",
    connections: prepared.filter((c) => !signalIds.includes(c.connectionIndex)),
    termination: { type: "plane", layer: "inner1" },
  }
  const preparedBuses = [bus, plane]
  const config = {
    srj,
    layerNames,
    traceWidth: width,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    allowBlindAndBuriedVias: false,
  }
  const matched = matchSourceViaSites(preparedBuses, {
    ...config,
    additionalObstacles: pads,
  })
  if (!matched) throw Error("Fixture requires initial source capacity")
  const sourceEscapes = prepared.map((connection) => ({
    connectionIndex: connection.connectionIndex,
    connectionName: connection.connection.name,
    segments: [
      {
        start: connection.sourcePoint,
        end: matched.get(connection.connectionIndex)!,
        width,
        layer: "top",
      },
    ],
    via: {
      center: matched.get(connection.connectionIndex)!,
      diameter: 0.24,
      holeDiameter: 0.1,
      fromLayer: "top",
      toLayer: "inner1",
      spanLayers: layerNames,
    },
  }))
  const acceptedPlans = plane.connections.map((connection) => {
    const source = sourceEscapes[connection.connectionIndex]!
    return buildViaMinimalWindingPlan({
      ...config,
      bus: plane,
      terminal: {
        connection,
        viaPoint: source.via.center,
        exitPoint: source.via.center,
      },
      targetLayer: "inner1",
      sourceEscapePoints: [connection.sourcePoint, source.via.center],
      targetLayerPoints: [source.via.center, source.via.center],
    })
  })
  return {
    boundary,
    params: {
      ...config,
      bus,
      preparedBuses,
      sourceEscapes,
      acceptedPlans,
      targetLayer: "inner1",
      terminals: bus.connections.map((connection) => ({
        connection,
        viaPoint: matched.get(connection.connectionIndex)!,
        exitPoint: { x: connection.targetPoint.x, y: boundary.minY },
      })),
      gridStep: width,
      gridStepDivisor: 2 as const,
      alignGridToPads: true,
      maximumRouteOrderAttempts: 16,
      maximumFeedbackRounds: 3,
      maximumPlaneCandidates: 16,
    },
  }
}
