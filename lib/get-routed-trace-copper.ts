import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getCopperLayerNames, getLayerSpan } from "./layer-names"
import type { Point2D, RoutedSegment } from "./types"

export interface RoutedTraceVia {
  center: Point2D
  diameter: number
  spanLayers: string[]
}

export interface RoutedTraceCopper {
  trace: SimplifiedPcbTrace
  connectionName: string
  segments: RoutedSegment[]
  vias: RoutedTraceVia[]
}

export function getRoutedTraceCopper(
  srj: SimpleRouteJson,
  trace: SimplifiedPcbTrace,
): RoutedTraceCopper {
  const layerNames = getCopperLayerNames(srj.layerCount)
  const segments: RoutedSegment[] = []
  const vias: RoutedTraceVia[] = []
  let previousWire:
    | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
    | undefined

  for (const routePoint of trace.route) {
    if (routePoint.route_type === "via") {
      vias.push({
        center: { x: routePoint.x, y: routePoint.y },
        diameter:
          routePoint.via_diameter ??
          srj.minViaPadDiameter ??
          srj.min_via_pad_diameter ??
          srj.minViaDiameter ??
          srj.minTraceWidth,
        spanLayers: getLayerSpan(
          routePoint.from_layer,
          routePoint.to_layer,
          layerNames,
        ),
      })
      previousWire = undefined
      continue
    }

    if (routePoint.route_type !== "wire") {
      previousWire = undefined
      continue
    }

    if (
      previousWire?.layer === routePoint.layer &&
      (previousWire.x !== routePoint.x || previousWire.y !== routePoint.y)
    ) {
      segments.push({
        start: { x: previousWire.x, y: previousWire.y },
        end: { x: routePoint.x, y: routePoint.y },
        width: Math.max(previousWire.width, routePoint.width),
        layer: routePoint.layer,
      })
    }
    previousWire = routePoint
  }

  return {
    trace,
    connectionName: trace.connection_name,
    segments,
    vias,
  }
}

export function getAllRoutedTraceCopper(
  srj: SimpleRouteJson,
): RoutedTraceCopper[] {
  return (srj.traces ?? []).map((trace) => getRoutedTraceCopper(srj, trace))
}
