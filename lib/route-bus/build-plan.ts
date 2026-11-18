import { createFanoutOutputIds } from "../fanout-output-ids"
import { distance } from "../geometry"
import { getViaSpanLayers } from "../layer-names"
import type { FanoutRoutePlan, Point2D, RoutedSegment } from "../types"
import { appendPlanBoundary } from "./append-plan-boundary"
import { getCornerSide } from "./directions"
import { appendSegment, getInitialViaPoint } from "./source-escape"
import type { BuildPlanParams } from "./types"
import type { SimplifiedPcbTrace } from "@tscircuit/capacity-autorouter"

export function buildPlan(params: BuildPlanParams): FanoutRoutePlan {
  const {
    preparedConnection,
    bus,
    targetLayer,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    viaHandedness,
    clearance,
    allowBlindAndBuriedVias,
    initialViaPoint,
    sourceEscapePath,
  } = params
  const cornerSide = getCornerSide(bus)
  const sourcePoint = {
    x: preparedConnection.sourcePoint.x,
    y: preparedConnection.sourcePoint.y,
  }
  const requestedViaPoint = sourceEscapePath?.at(-1)
  const viaPoint =
    requestedViaPoint !== undefined
      ? { x: requestedViaPoint.x, y: requestedViaPoint.y }
      : initialViaPoint === undefined
        ? getInitialViaPoint({
            preparedConnection,
            bus,
            targetLayer,
            traceWidth,
            viaDiameter,
            clearance,
            viaHandedness,
          })
        : { x: initialViaPoint.x, y: initialViaPoint.y }
  const resolvedSourceEscapePath = sourceEscapePath
    ? sourceEscapePath.map((point) => ({ x: point.x, y: point.y }))
    : [sourcePoint, viaPoint]
  if (
    resolvedSourceEscapePath.length < 2 ||
    distance(resolvedSourceEscapePath[0]!, sourcePoint) > 1e-9 ||
    distance(resolvedSourceEscapePath.at(-1)!, viaPoint) > 1e-9
  ) {
    throw new Error(
      `FanoutSolver: source escape path for "${preparedConnection.connection.name}" must run from its source point to its via`,
    )
  }
  const segments: RoutedSegment[] = []
  const route: SimplifiedPcbTrace["route"] = []

  route.push({
    route_type: "wire",
    x: sourcePoint.x,
    y: sourcePoint.y,
    width: traceWidth,
    layer: preparedConnection.sourceLayer,
    start_pcb_port_id: preparedConnection.sourcePoint.pcb_port_id,
  })
  for (
    let pointIndex = 1;
    pointIndex < resolvedSourceEscapePath.length;
    pointIndex++
  ) {
    const previousPoint = resolvedSourceEscapePath[pointIndex - 1]!
    const point = resolvedSourceEscapePath[pointIndex]!
    appendSegment({
      segments,
      start: previousPoint,
      end: point,
      width: traceWidth,
      layer: preparedConnection.sourceLayer,
    })
    if (distance(previousPoint, point) <= 1e-9) continue
    route.push({
      route_type: "wire",
      x: point.x,
      y: point.y,
      width: traceWidth,
      layer: preparedConnection.sourceLayer,
    })
  }

  const sourceEscapeSegmentCount = segments.length
  let via: FanoutRoutePlan["via"]
  if (targetLayer !== preparedConnection.sourceLayer) {
    const spanLayers = getViaSpanLayers({
      fromLayer: preparedConnection.sourceLayer,
      toLayer: targetLayer,
      layerNames,
      allowBlindAndBuriedVias,
    })
    via = {
      center: viaPoint,
      diameter: viaDiameter,
      holeDiameter: viaHoleDiameter,
      fromLayer: preparedConnection.sourceLayer,
      toLayer: targetLayer,
      spanLayers,
    }
    route.push({
      route_type: "via",
      x: viaPoint.x,
      y: viaPoint.y,
      from_layer: preparedConnection.sourceLayer,
      to_layer: targetLayer,
      via_diameter: viaDiameter,
      via_hole_diameter: viaHoleDiameter,
    })
    route.push({
      route_type: "wire",
      x: viaPoint.x,
      y: viaPoint.y,
      width: traceWidth,
      layer: targetLayer,
    })
  }

  const { exitPoint, additionalVias } = appendPlanBoundary(
    { viaPoint, segments, route },
    params,
  )

  const outputIds = createFanoutOutputIds({
    connectionName: preparedConnection.connection.name,
    sourcePointIndex: preparedConnection.sourcePointIndex,
  })
  return {
    busId: bus.busId,
    connectionName: preparedConnection.connection.name,
    connectionIndex: preparedConnection.connectionIndex,
    sourcePointIndex: preparedConnection.sourcePointIndex,
    sourcePoint: preparedConnection.sourcePoint,
    sourceObstacle: preparedConnection.sourceObstacle,
    sourceLayer: preparedConnection.sourceLayer,
    targetPoint: preparedConnection.targetPoint,
    targetLayer,
    termination: bus.termination,
    direction: bus.direction,
    ...(bus.exitEdge ? { exitEdge: bus.exitEdge } : {}),
    ...(cornerSide ? { cornerBandSide: cornerSide } : {}),
    exitPoint,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: outputIds.traceId,
      connection_name: preparedConnection.connection.name,
      connectsTo: [
        ...(preparedConnection.sourcePoint.pointId
          ? [preparedConnection.sourcePoint.pointId]
          : []),
        ...(preparedConnection.sourcePoint.pcb_port_id
          ? [preparedConnection.sourcePoint.pcb_port_id]
          : []),
        outputIds.boundaryExitPointId,
      ],
      route,
    },
    segments,
    ...(sourceEscapeSegmentCount > 1 ? { sourceEscapeSegmentCount } : {}),
    via,
    ...(additionalVias.length > 0 ? { additionalVias } : {}),
    length: segments.reduce(
      (total, segment) => total + distance(segment.start, segment.end),
      0,
    ),
  }
}
