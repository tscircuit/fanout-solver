import type { Obstacle } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import { createPlanWithSegments } from "./match-bus-lengths"
import {
  changedFanoutCopperIsSelfClear,
  type FanoutPlanCornerNormalizationParams,
} from "./normalize-fanout-plan-corners"
import { normalizeLayeredPath } from "./normalize-layered-path"
import { createFanoutPlanClearanceValidator } from "./route-bus"
import { RouteSegmentSpatialIndex } from "./route-segment-spatial-index"
import { getSourcePadReentries } from "./source-pad-reentry"
import { sourcePrefixFoldShortcuts } from "./source-prefix-fold-shortcuts"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"
import {
  segmentIsLegalTerminalBodyEscape,
  validateRoutedCopperDrc,
} from "./validate-routed-copper-drc"

const EPSILON = 1e-7
const MAXIMUM_SOURCE_ANCHORS = 64

interface Params extends FanoutPlanCornerNormalizationParams {
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
}

function padEnds(
  pad: Obstacle,
  source: Point2D,
  margin: number,
): Point2D[] | null {
  const shaped = pad as Obstacle & {
    shape?: string
    ccwRotationDegrees?: number
  }
  const turns = (shaped.ccwRotationDegrees ?? 0) / 90
  if (
    pad.type !== "rect" ||
    shaped.shape === "circle" ||
    Math.abs(turns - Math.round(turns)) > EPSILON ||
    Math.abs(pad.width - pad.height) < EPSILON
  )
    return null
  const swapped = Math.abs(Math.round(turns)) % 2 === 1
  const width = swapped ? pad.height : pad.width
  const height = swapped ? pad.width : pad.height
  const axis = width > height ? "x" : "y"
  const half = (axis === "x" ? width : height) / 2
  return [-1, 1].map((sign) => ({
    ...source,
    [axis]: pad.center[axis] + sign * (half + margin),
  }))
}

/**
 * Private geometric repair, before original bus/pair length matching. Replace
 * only source prefixes; every first via and all subsequent copper stay fixed.
 * At most 384 source proposals and 64 local fold shortcuts per affected plan;
 * failure rolls back the whole set.
 */
export function repairSourcePadReentries(
  params: Params,
): FanoutRoutePlan[] | null {
  const { inputSrj, preparedBuses, layerNames, traceWidth, clearance } = params
  const first = preparedBuses[0]
  if (!first) return params.plans.length ? null : []
  const bounds = first.sharedBoundary
  if (
    preparedBuses.some((bus) =>
      (["minX", "maxX", "minY", "maxY"] as const).some(
        (key) => bus.sharedBoundary[key] !== bounds[key],
      ),
    )
  )
    return null
  const owners = new Map(preparedBuses.map((bus) => [bus.busId, bus]))
  if (
    new Set(params.plans.map((p) => p.connectionIndex)).size !==
    params.plans.length
  )
    return null
  let plans = [...params.plans]
  const supplied = getAllRoutedTraceCopper(inputSrj, false)
  const clearPlans = createFanoutPlanClearanceValidator({
    srj: inputSrj,
    sharedBoundary: bounds,
    clearance,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  })
  for (const [planIndex, original] of plans.entries()) {
    if (!getSourcePadReentries(original, clearance).length) continue
    const bus = owners.get(original.busId)
    const connection = bus?.connections.find(
      (c) => c.connectionIndex === original.connectionIndex,
    )
    const sourceCount = original.sourceEscapeSegmentCount ?? 1
    const prefix = original.segments.slice(0, sourceCount)
    const firstVia = original.trace.route.findIndex(
      (p) => p.route_type === "via",
    )
    const ends = padEnds(
      original.sourceObstacle,
      original.sourcePoint,
      traceWidth / 2 + clearance + 1e-6,
    )
    if (
      !connection ||
      connection.sourceObstacle !== original.sourceObstacle ||
      !original.via ||
      firstVia < 1 ||
      !ends ||
      !prefix.length ||
      prefix.some(
        (s) => s.layer !== original.sourceLayer || s.width !== traceWidth,
      ) ||
      distance(prefix[0]!.start, original.sourcePoint) > EPSILON ||
      distance(prefix.at(-1)!.end, original.via.center) > EPSILON ||
      !layerNames.includes(original.sourceLayer)
    )
      return null
    const others = plans.filter((_, index) => index !== planIndex)
    const index = new RouteSegmentSpatialIndex([
      ...original.segments.slice(sourceCount),
      ...(original.planeEndpointSegments ?? []),
      ...others.flatMap((p) => [
        ...p.segments,
        ...(p.planeEndpointSegments ?? []),
      ]),
      ...supplied.flatMap((p) => p.segments),
    ])
    const vias = [
      ...(original.additionalVias ?? []),
      ...(original.planeEndpointVia ? [original.planeEndpointVia] : []),
      ...others.flatMap((p) =>
        [p.via, ...(p.additionalVias ?? []), p.planeEndpointVia].filter(
          (v) => !!v,
        ),
      ),
      ...supplied.flatMap((p) => p.vias),
    ]
    const anchors = [
      ...new Set([
        ...Array.from(
          { length: Math.min(prefix.length, MAXIMUM_SOURCE_ANCHORS - 1) },
          (_, i) => i + 1,
        ),
        prefix.length,
      ]),
    ]
    const proposals: { anchor: number; points: Point2D[]; length: number }[] =
      []
    const seen = new Set<string>()
    for (const anchor of anchors) {
      const target = prefix[anchor - 1]!.end
      for (const lead of [null, ...ends]) {
        const start = lead ?? original.sourcePoint
        const dx = target.x - start.x,
          dy = target.y - start.y
        const diagonal = Math.min(Math.abs(dx), Math.abs(dy))
        for (const bend of [
          {
            x: start.x + Math.sign(dx) * diagonal,
            y: start.y + Math.sign(dy) * diagonal,
          },
          {
            x: target.x - Math.sign(dx) * diagonal,
            y: target.y - Math.sign(dy) * diagonal,
          },
        ]) {
          const points = [
            original.sourcePoint,
            ...(lead ? [lead] : []),
            bend,
            target,
          ].filter((p, i, all) => i === 0 || distance(p, all[i - 1]!) > EPSILON)
          const key = JSON.stringify([anchor, points])
          if (seen.has(key)) continue
          seen.add(key)
          const length =
            points
              .slice(1)
              .reduce((sum, p, i) => sum + distance(points[i]!, p), 0) +
            prefix
              .slice(anchor)
              .reduce((sum, s) => sum + distance(s.start, s.end), 0)
          proposals.push({ anchor, points, length })
        }
      }
    }
    proposals.sort((a, b) => a.length - b.length || a.anchor - b.anchor)
    const sourceCandidate = (
      points: readonly Point2D[],
    ): FanoutRoutePlan | null => {
      const normalized = normalizeLayeredPath({
        points: points.map((p) => ({
          ...p,
          z: layerNames.indexOf(original.sourceLayer),
        })),
        chamfer: traceWidth / 2,
        segmentIsClear: (a, b) => {
          if (
            [a, b].some(
              (p) =>
                p.x < bounds.minX ||
                p.x > bounds.maxX ||
                p.y < bounds.minY ||
                p.y > bounds.maxY,
            )
          )
            return false
          const segment = {
            start: a,
            end: b,
            width: traceWidth,
            layer: original.sourceLayer,
          }
          return (
            inputSrj.obstacles.every(
              (obstacle) =>
                obstacle === original.sourceObstacle ||
                !obstacle.layers.includes(segment.layer) ||
                distanceSegmentToObstacle(segment, obstacle) >=
                  traceWidth / 2 + clearance - EPSILON ||
                segmentIsLegalTerminalBodyEscape({
                  inputSrj,
                  segment,
                  bodyObstacle: obstacle,
                  connectionName: original.connectionName,
                }),
            ) &&
            index
              .querySegment(segment, clearance)
              .every((other) => segmentsAreClear(segment, other, clearance)) &&
            vias.every(
              (via) =>
                !via.spanLayers.includes(segment.layer) ||
                distancePointToSegment(via.center, a, b) >=
                  (traceWidth + via.diameter) / 2 + clearance - EPSILON,
            )
          )
        },
      })
      if (!normalized) return null
      const replacement = normalized
        .slice(1)
        .map((end, i) => ({
          start: { x: normalized[i]!.x, y: normalized[i]!.y },
          end: { x: end.x, y: end.y },
          width: traceWidth,
          layer: original.sourceLayer,
        }))
        .filter((s) => distance(s.start, s.end) > EPSILON)
      const segments = [...replacement, ...original.segments.slice(sourceCount)]
      const candidate = createPlanWithSegments(original, segments, true)
      if (!candidate) return null
      // Rebuilding may omit a terminal plane via. Retain the actual trace
      // suffix verbatim, including every original transition and wire metadata.
      candidate.sourceEscapeSegmentCount = replacement.length
      candidate.trace = {
        ...original.trace,
        route: [
          original.trace.route[0]!,
          ...replacement.map((s) => ({
            route_type: "wire" as const,
            ...s.end,
            width: s.width,
            layer: s.layer,
          })),
          ...original.trace.route.slice(firstVia),
        ],
      }
      return getSourcePadReentries(candidate, clearance).length ||
        !clearPlans([...others, candidate])
        ? null
        : candidate
    }
    const sourceIsSelfClear = (candidate: FanoutRoutePlan) =>
      changedFanoutCopperIsSelfClear(
        candidate,
        candidate.segments,
        clearance,
        new Set(
          Array.from(
            { length: candidate.sourceEscapeSegmentCount ?? 1 },
            (_, i) => i,
          ),
        ),
      )
    let repaired: FanoutRoutePlan | null = null
    let folded: FanoutRoutePlan | null = null
    for (const proposal of proposals) {
      const candidate = sourceCandidate([
        ...proposal.points,
        ...prefix.slice(proposal.anchor).map((s) => s.end),
      ])
      if (!candidate) continue
      if (!sourceIsSelfClear(candidate)) {
        folded ??= candidate
        continue
      }
      repaired = candidate
      break
    }
    // A valid pad departure can retain a tiny returning arm farther along its
    // original source walk. Try one finite local shortcut around the first
    // conflict, still holding every target segment and first via fixed.
    if (!repaired && folded) {
      for (const points of sourcePrefixFoldShortcuts(folded, clearance)) {
        const candidate = sourceCandidate(points)
        if (candidate && sourceIsSelfClear(candidate)) {
          repaired = candidate
          break
        }
      }
    }
    if (!repaired) return null
    plans[planIndex] = repaired
  }
  if (
    plans.some((p) => getSourcePadReentries(p, clearance).length) ||
    !clearPlans(plans)
  )
    return null
  return validateRoutedCopperDrc({
    inputSrj,
    routedSrj: {
      ...inputSrj,
      traces: [
        ...(inputSrj.traces ?? []),
        ...plans.flatMap((p) => [
          p.trace,
          ...(p.planeEndpointTrace ? [p.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance,
    allowBlindAndBuriedVias: false,
  }).valid
    ? plans
    : null
}
