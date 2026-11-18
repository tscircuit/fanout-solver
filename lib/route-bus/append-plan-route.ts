import { getViaSpanLayers } from "../layer-names"
import type { FanoutRoutePlan, Point2D, RoutedSegment } from "../types"
import { appendSegment } from "./source-escape"
import type { BuildPlanParams } from "./types"
import type { SimplifiedPcbTrace } from "@tscircuit/capacity-autorouter"

export function appendLayerPath(
  { points, layer }: { points: Point2D[]; layer: string },
  {
    segments,
    route,
    traceWidth,
  }: {
    segments: RoutedSegment[]
    route: SimplifiedPcbTrace["route"]
    traceWidth: number
  },
): void {
  for (let index = 1; index < points.length; index++) {
    const previousPoint = points[index - 1]!
    const nextPoint = points[index]!
    appendSegment({
      segments,
      start: previousPoint,
      end: nextPoint,
      width: traceWidth,
      layer,
    })
    route.push({
      route_type: "wire",
      x: nextPoint.x,
      y: nextPoint.y,
      width: traceWidth,
      layer,
    })
  }
}

export function appendTransitionVia(
  {
    center,
    fromLayer,
    toLayer,
  }: { center: Point2D; fromLayer: string; toLayer: string },
  {
    additionalVias,
    route,
    layerNames,
    allowBlindAndBuriedVias,
    viaDiameter,
    viaHoleDiameter,
    traceWidth,
  }: Pick<
    BuildPlanParams,
    | "layerNames"
    | "allowBlindAndBuriedVias"
    | "viaDiameter"
    | "viaHoleDiameter"
    | "traceWidth"
  > & {
    additionalVias: NonNullable<FanoutRoutePlan["additionalVias"]>
    route: SimplifiedPcbTrace["route"]
  },
): void {
  if (fromLayer === toLayer) return
  additionalVias.push({
    center,
    diameter: viaDiameter,
    holeDiameter: viaHoleDiameter,
    fromLayer,
    toLayer,
    spanLayers: getViaSpanLayers({
      fromLayer,
      toLayer,
      layerNames,
      allowBlindAndBuriedVias,
    }),
  })
  route.push({
    route_type: "via",
    x: center.x,
    y: center.y,
    from_layer: fromLayer,
    to_layer: toLayer,
    via_diameter: viaDiameter,
    via_hole_diameter: viaHoleDiameter,
  })
  route.push({
    route_type: "wire",
    x: center.x,
    y: center.y,
    width: traceWidth,
    layer: toLayer,
  })
}
