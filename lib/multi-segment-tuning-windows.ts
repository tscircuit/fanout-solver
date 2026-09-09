import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  RoutedSegment,
  RoutedVia,
} from "./types"

export interface MultiSegmentTuningWindow {
  before: RoutedSegment[]
  window: RoutedSegment[]
  after: RoutedSegment[]
  tuningLayer: string
  addedVias: RoutedVia[]
}

/** Open a bounded, exterior tuning window without moving the original first via. */
export function* getMultiSegmentTuningWindows(params: {
  plan: FanoutRoutePlan
  bus: PreparedBus
  inputSrj: SimpleRouteJson
  plans: readonly FanoutRoutePlan[]
  layerNames: string[]
  clearance: number
  consumeWork: () => void
}): Generator<MultiSegmentTuningWindow> {
  const { plan, bus, inputSrj, layerNames, clearance, consumeWork } = params
  if (!plan.via || (plan.additionalVias?.length ?? 0) > 4) return
  const layers = (
    bus.routableEscapeLayers ??
    bus.allowedLayers ??
    layerNames
  ).filter(
    (layer) =>
      layer !== plan.targetLayer &&
      layerNames.includes(layer) &&
      (bus.allowedLayers ?? layerNames).includes(layer),
  )
  if (!layers.length) return
  const others = params.plans.filter(
    (p) => p.connectionIndex !== plan.connectionIndex,
  )
  const supplied = getAllRoutedTraceCopper(inputSrj, false)
  const segments = [
    ...others.flatMap((p) => [
      ...p.segments,
      ...(p.planeEndpointSegments ?? []),
    ]),
    ...supplied.flatMap((p) => p.segments),
  ]
  const vias = [
    ...params.plans.flatMap((p) =>
      [p.via, ...(p.additionalVias ?? []), p.planeEndpointVia].filter(
        (v): v is RoutedVia => !!v,
      ),
    ),
    ...supplied.flatMap((p) => p.vias),
  ]
  const diameter = plan.via.diameter
  const bounds = bus.sharedBoundary
  const dense = bus.componentBounds
  const margin = diameter / 2 + clearance
  const points: { index: number; point: Point2D }[] = []
  for (const [index, segment] of plan.segments.entries()) {
    if (
      segment.layer !== plan.targetLayer ||
      index < (plan.sourceEscapeSegmentCount ?? 1)
    )
      continue
    const length = distance(segment.start, segment.end)
    const steps = Math.max(1, Math.ceil(length / (segment.width / 2)))
    for (let step = 0; step <= steps; step++) {
      consumeWork()
      const fraction = step / steps
      const point = {
        x: segment.start.x + (segment.end.x - segment.start.x) * fraction,
        y: segment.start.y + (segment.end.y - segment.start.y) * fraction,
      }
      if (
        point.x >= dense.minX - margin &&
        point.x <= dense.maxX + margin &&
        point.y >= dense.minY - margin &&
        point.y <= dense.maxY + margin
      )
        continue
      if (
        Math.min(
          point.x - bounds.minX,
          bounds.maxX - point.x,
          point.y - bounds.minY,
          bounds.maxY - point.y,
        ) <
        diameter / 2 + 1e-7
      )
        continue
      if (points.some((p) => distance(p.point, point) < 1e-7)) continue
      // A through-via must clear every physical pad, trace and existing barrel,
      // including the retained first via on this same connection.
      if (
        inputSrj.obstacles.some(
          (o) => distancePointToObstacle(point, o) < margin - 1e-9,
        )
      )
        continue
      if (
        vias.some(
          (v) =>
            distance(point, v.center) <
            (diameter + v.diameter) / 2 + clearance - 1e-9,
        )
      )
        continue
      if (
        segments.some(
          (s) =>
            distancePointToSegment(point, s.start, s.end) <
            (diameter + s.width) / 2 + clearance - 1e-9,
        )
      )
        continue
      points.push({ index, point })
      if (points.length === 64) break
    }
    if (points.length === 64) break
  }
  const spans = points
    .flatMap((a, i) =>
      points.slice(i + 1).flatMap((b) => {
        if (
          a.index >= b.index ||
          distance(a.point, b.point) < diameter + clearance
        )
          return []
        const middle = plan.segments.slice(a.index, b.index + 1)
        if (middle.some((s) => s.layer !== plan.targetLayer)) return []
        return [
          {
            a,
            b,
            length: middle.reduce((n, s) => n + distance(s.start, s.end), 0),
          },
        ]
      }),
    )
    .sort((a, b) => b.length - a.length)
  for (const { a, b } of spans) {
    const first = plan.segments[a.index]!,
      last = plan.segments[b.index]!
    const before = [
      ...plan.segments.slice(0, a.index),
      { ...first, end: a.point },
    ].filter((s) => distance(s.start, s.end) > 1e-7)
    const after = [
      { ...last, start: b.point },
      ...plan.segments.slice(b.index + 1),
    ].filter((s) => distance(s.start, s.end) > 1e-7)
    const old = [
      { ...first, start: a.point },
      ...plan.segments.slice(a.index + 1, b.index),
      { ...last, end: b.point },
    ].filter((s) => distance(s.start, s.end) > 1e-7)
    const dx = b.point.x - a.point.x,
      dy = b.point.y - a.point.y
    const diagonal = Math.min(Math.abs(dx), Math.abs(dy))
    const bends = [
      {
        x: a.point.x + Math.sign(dx) * diagonal,
        y: a.point.y + Math.sign(dy) * diagonal,
      },
      {
        x: b.point.x - Math.sign(dx) * diagonal,
        y: b.point.y - Math.sign(dy) * diagonal,
      },
    ]
    const variants = [
      old,
      ...bends.map((bend) =>
        [
          { ...first, start: a.point, end: bend },
          { ...first, start: bend, end: b.point },
        ].filter((s) => distance(s.start, s.end) > 1e-7),
      ),
    ]
    for (const tuningLayer of layers) {
      const foreign = segments.filter((s) => s.layer === tuningLayer)
      const barrels = vias.filter((v) => v.spanLayers.includes(tuningLayer))
      const obstacles = inputSrj.obstacles.filter((o) =>
        o.layers.includes(tuningLayer),
      )
      const addedVias: RoutedVia[] = [
        {
          ...plan.via,
          center: a.point,
          fromLayer: plan.targetLayer,
          toLayer: tuningLayer,
          spanLayers: layerNames,
        },
        {
          ...plan.via,
          center: b.point,
          fromLayer: tuningLayer,
          toLayer: plan.targetLayer,
          spanLayers: layerNames,
        },
      ]
      for (const variant of variants) {
        consumeWork()
        const window = variant.map((s) => ({ ...s, layer: tuningLayer }))
        // Source-layer returns receive no source-pad or same-net barrel exception.
        if (
          window.some(
            (s) =>
              foreign.some((other) => !segmentsAreClear(s, other, clearance)) ||
              barrels.some(
                (v) =>
                  distancePointToSegment(v.center, s.start, s.end) <
                  (v.diameter + s.width) / 2 + clearance - 1e-9,
              ) ||
              obstacles.some(
                (o) =>
                  distanceSegmentToObstacle(s, o) <
                  s.width / 2 + clearance - 1e-9,
              ),
          )
        )
          continue
        yield { before, window, after, tuningLayer, addedVias }
      }
    }
  }
}
