import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getViaSpanLayers } from "./layer-names"
import type {
  FanoutSimplifiedPcbTrace,
  SimpleRouteJsonWithFanoutPlanes,
} from "./types"

export function addViaLayerMetadataToTrace(params: {
  trace: FanoutSimplifiedPcbTrace
  layerNames: string[]
  allowBlindAndBuriedVias: boolean
}): FanoutSimplifiedPcbTrace {
  const { trace, layerNames, allowBlindAndBuriedVias } = params
  return {
    ...trace,
    route: trace.route.map((routePoint) =>
      routePoint.route_type === "via" && !allowBlindAndBuriedVias
        ? {
            ...routePoint,
            layers: getViaSpanLayers({
              fromLayer: routePoint.from_layer,
              toLayer: routePoint.to_layer,
              layerNames,
              allowBlindAndBuriedVias,
            }),
          }
        : { ...routePoint },
    ),
  }
}

export function addViaLayerMetadataToSrj(params: {
  srj: SimpleRouteJsonWithFanoutPlanes | SimpleRouteJson
  layerNames: string[]
  allowBlindAndBuriedVias: boolean
}): SimpleRouteJsonWithFanoutPlanes {
  const { srj, layerNames, allowBlindAndBuriedVias } = params
  return {
    ...srj,
    traces: (srj.traces ?? []).map((trace) =>
      addViaLayerMetadataToTrace({
        trace,
        layerNames,
        allowBlindAndBuriedVias,
      }),
    ),
  }
}
