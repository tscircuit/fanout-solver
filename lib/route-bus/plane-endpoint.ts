import { createFanoutOutputIds } from "../fanout-output-ids"
import { distance } from "../geometry"
import { getViaSpanLayers } from "../layer-names"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "../types"
import { getPointLayer } from "./winding-target-orders"
import type { SimplifiedPcbTrace } from "@tscircuit/capacity-autorouter"

export function getPlaneEndpointViaCandidates(params: {
  preparedConnection: PreparedConnection
  bus: PreparedBus
  viaDiameter: number
  clearance: number
}): Point2D[] {
  const { preparedConnection, bus, viaDiameter, clearance } = params
  const { sourcePoint, targetPoint } = preparedConnection
  const nearbyEndpointLimit = Math.max(bus.pitchX, bus.pitchY) * 0.5
  if (
    distance(sourcePoint, targetPoint) <= 1e-6 ||
    distance(sourcePoint, targetPoint) > nearbyEndpointLimit
  ) {
    return []
  }

  const preferred = (() => {
    switch (bus.direction) {
      case "left":
        return { x: -1, y: 0 }
      case "right":
        return { x: 1, y: 0 }
      case "up":
        return { x: 0, y: 1 }
      case "down":
        return { x: 0, y: -1 }
    }
  })()
  const diagonal = Math.SQRT1_2
  const directions = [
    preferred,
    ...[
      { x: diagonal, y: diagonal },
      { x: diagonal, y: -diagonal },
      { x: -diagonal, y: diagonal },
      { x: -diagonal, y: -diagonal },
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ].toSorted(
      (first, second) =>
        second.x * preferred.x +
        second.y * preferred.y -
        (first.x * preferred.x + first.y * preferred.y),
    ),
  ]
  const minimumRadius = Math.max(viaDiameter, viaDiameter / 2 + clearance)
  const radii = [
    minimumRadius,
    Math.max(minimumRadius, Math.min(bus.pitchX, bus.pitchY) * 0.5),
    Math.max(minimumRadius, Math.min(bus.pitchX, bus.pitchY) * 0.625),
    Math.max(minimumRadius, Math.min(bus.pitchX, bus.pitchY) * 0.75),
  ]
  const candidates: Point2D[] = []
  for (const origin of [sourcePoint, targetPoint]) {
    for (const radius of radii) {
      for (const direction of directions) {
        const candidate = {
          x: origin.x + direction.x * radius,
          y: origin.y + direction.y * radius,
        }
        if (
          distance(candidate, sourcePoint) <= 1e-6 ||
          distance(candidate, targetPoint) <= 1e-6 ||
          candidates.some((existing) => distance(existing, candidate) <= 1e-6)
        ) {
          continue
        }
        candidates.push(candidate)
      }
    }
  }
  return candidates
}

export function addPlaneEndpointTerminal(params: {
  plan: FanoutRoutePlan
  preparedConnection: PreparedConnection
  planeLayer: string
  viaPoint: Point2D
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  allowBlindAndBuriedVias: boolean
}): FanoutRoutePlan {
  const {
    plan,
    preparedConnection,
    planeLayer,
    viaPoint,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    allowBlindAndBuriedVias,
  } = params
  const targetPoint = {
    x: preparedConnection.targetPoint.x,
    y: preparedConnection.targetPoint.y,
  }
  const targetEndpointLayer = getPointLayer(preparedConnection.targetPoint)
  const spanLayers = getViaSpanLayers({
    fromLayer: planeLayer,
    toLayer: targetEndpointLayer,
    layerNames,
    allowBlindAndBuriedVias,
  })
  if (!spanLayers.includes(planeLayer)) {
    throw new Error(
      `FanoutSolver: via for "${preparedConnection.connection.name}" does not cross plane ${planeLayer}`,
    )
  }
  const planeEndpointSegments: RoutedSegment[] = [
    {
      start: viaPoint,
      end: targetPoint,
      width: traceWidth,
      layer: targetEndpointLayer,
    },
  ]
  const via = {
    center: viaPoint,
    diameter: viaDiameter,
    holeDiameter: viaHoleDiameter,
    fromLayer: planeLayer,
    toLayer: targetEndpointLayer,
    spanLayers,
  }
  const outputIds = createFanoutOutputIds({
    connectionName: preparedConnection.connection.name,
    sourcePointIndex: preparedConnection.sourcePointIndex,
  })
  const planeEndpointTrace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: outputIds.planeEndpointTraceId,
    connection_name: preparedConnection.connection.name,
    connectsTo: [
      ...(preparedConnection.targetPoint.pointId
        ? [preparedConnection.targetPoint.pointId]
        : []),
      ...(preparedConnection.targetPoint.pcb_port_id
        ? [preparedConnection.targetPoint.pcb_port_id]
        : []),
      outputIds.planeEndpointPointId,
    ],
    route: [
      {
        route_type: "wire",
        ...viaPoint,
        width: traceWidth,
        layer: planeLayer,
      },
      {
        route_type: "via",
        ...viaPoint,
        from_layer: planeLayer,
        to_layer: targetEndpointLayer,
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      },
      {
        route_type: "wire",
        ...viaPoint,
        width: traceWidth,
        layer: targetEndpointLayer,
      },
      {
        route_type: "wire",
        ...targetPoint,
        width: traceWidth,
        layer: targetEndpointLayer,
      },
    ],
  }
  return {
    ...plan,
    planeEndpointTrace,
    planeEndpointSegments,
    planeEndpointVia: via,
    length:
      plan.length +
      planeEndpointSegments.reduce(
        (total, segment) => total + distance(segment.start, segment.end),
        0,
      ),
  }
}
