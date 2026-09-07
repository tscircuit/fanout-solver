import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import {
  getAllRoutedTraceCopper,
  getRoutedTraceCopper,
} from "./get-routed-trace-copper"
import { normalizeLayeredPath } from "./normalize-layered-path"
import { repairBoundaryRouteTails } from "./repair-boundary-route-tails"
import { RouteSegmentSpatialIndex } from "./route-segment-spatial-index"
import type { FanoutRoutePlan, PreparedBus, RoutedSegment } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

export interface FanoutPlanCornerNormalizationParams {
  inputSrj: SimpleRouteJson
  layerNames: string[]
  traceWidth: number
  clearance: number
}
export interface FinalFanoutPlanNormalizationParams
  extends FanoutPlanCornerNormalizationParams {
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  viaDiameter: number
  viaHoleDiameter: number
}
const EPSILON = 1e-7

/** Check new copper without reinterpreting retained runs as one replaced edge. */
export function changedFanoutCopperIsSelfClear(
  plan: FanoutRoutePlan,
  segments: readonly RoutedSegment[],
  clearance: number,
): boolean {
  const lengths = new Float64Array(segments.length + 1)
  const groups = new Int32Array(segments.length)
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!,
      previous = segments[index - 1]
    lengths[index + 1] = lengths[index]! + distance(segment.start, segment.end)
    groups[index] =
      index === 0
        ? 0
        : groups[index - 1]! +
          Number(
            previous!.layer !== segment.layer ||
              distance(previous!.end, segment.start) > EPSILON,
          )
  }
  const vias = [
    plan.via,
    ...(plan.additionalVias ?? []),
    plan.planeEndpointVia,
  ].filter((v) => !!v)
  const connectsMonotonically = (lo: number, hi: number): boolean => {
    if (groups[lo] !== groups[hi]) return false
    let xSign = 0,
      ySign = 0
    for (let index = lo; index <= hi; index++) {
      const segment = segments[index]!
      const dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      if (Math.abs(dx) > EPSILON) {
        const sign = Math.sign(dx)
        if (xSign && xSign !== sign) return false
        xSign = sign
      }
      if (Math.abs(dy) > EPSILON) {
        const sign = Math.sign(dy)
        if (ySign && ySign !== sign) return false
        ySign = sign
      }
    }
    return true
  }
  for (const [index, segment] of segments.entries()) {
    // Splitting or trimming an original straight run introduces no copper.
    if (
      plan.segments.some(
        (old) =>
          old.layer === segment.layer &&
          old.width === segment.width &&
          distancePointToSegment(segment.start, old.start, old.end) <=
            EPSILON &&
          distancePointToSegment(segment.end, old.start, old.end) <= EPSILON,
      )
    )
      continue
    for (const [otherIndex, other] of segments.entries()) {
      if (other.layer !== segment.layer) continue
      const required = (segment.width + other.width) / 2 + clearance
      const lo = Math.min(index, otherIndex),
        hi = Math.max(index, otherIndex)
      // Consecutive short chamfers form a single connected trace body. Beyond
      // that local body, every retained and changed run is hard copper.
      if (
        groups[index] === groups[otherIndex] &&
        Math.max(0, lengths[hi]! - lengths[lo + 1]!) <= required + EPSILON
      )
        continue
      if (!segmentsAreClear(segment, other, clearance)) {
        // Several tiny 45-degree bends may form one uninterrupted staircase.
        // Such a monotone run cannot fold onto itself. A nearby returning arm
        // has a sign reversal and retains the full configured clearance.
        if (!connectsMonotonically(lo, hi)) return false
      }
    }
    for (const via of vias) {
      if (!via.spanLayers.includes(segment.layer)) continue
      const required = (segment.width + via.diameter) / 2 + clearance
      if (
        distancePointToSegment(via.center, segment.start, segment.end) >=
        required - EPSILON
      )
        continue
      if (
        [segment.start, segment.end].some(
          (p) => distance(p, via.center) <= EPSILON,
        )
      )
        continue
      const joinsVia = (direction: -1 | 1): boolean => {
        let point = direction === -1 ? segment.start : segment.end
        const far = direction === -1 ? segment.end : segment.start
        if (
          distance(point, via.center) > required + EPSILON ||
          (point.x - via.center.x) * (far.x - point.x) +
            (point.y - via.center.y) * (far.y - point.y) <
            -EPSILON
        )
          return false
        for (
          let adjacent = index + direction;
          adjacent >= 0 && adjacent < segments.length;
          adjacent += direction
        ) {
          const next = segments[adjacent]!
          if (
            next.layer !== segment.layer ||
            distance(point, direction === -1 ? next.end : next.start) > EPSILON
          )
            return false
          const nearer = direction === -1 ? next.start : next.end
          // A connected lead may bend while leaving its via. Its path length
          // can exceed the radial clearance radius without returning toward
          // the barrel. Require radial monotonicity over the entire segment,
          // not merely proximity to a via elsewhere on the same net.
          if (
            distance(nearer, via.center) > required + EPSILON ||
            (nearer.x - via.center.x) * (nearer.x - point.x) +
              (nearer.y - via.center.y) * (nearer.y - point.y) >
              EPSILON
          )
            return false
          point = nearer
          if (distance(point, via.center) <= EPSILON) return true
        }
        return false
      }
      if (!joinsVia(-1) && !joinsVia(1)) return false
    }
  }
  return true
}

/** Normalize target-side corners, retaining the source prefix and every via. */
export function normalizeFanoutPlanTargetPath(
  params: FanoutPlanCornerNormalizationParams,
  plan: FanoutRoutePlan,
  others: readonly FanoutRoutePlan[],
  bus: PreparedBus,
  removeReversingCorners = false,
): FanoutRoutePlan | null {
  const { inputSrj, layerNames, traceWidth, clearance } = params
  const firstVia = plan.trace.route.findIndex((p) => p.route_type === "via")
  if (firstVia < 0) return null
  const points = plan.trace.route
    .slice(firstVia + 1)
    .flatMap((p) =>
      p.route_type === "wire"
        ? [{ x: p.x, y: p.y, z: layerNames.indexOf(p.layer) }]
        : [],
    )
  // A temporary cut has no incoming heading. Remove a reversing join before
  // trying exact-clearance endpoint bends and 45-degree chamfers below.
  for (let i = 1; removeReversingCorners && i < points.length - 1; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      c = points[i + 1]!
    if (a.z !== b.z || b.z !== c.z) continue
    const dot =
      ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
      (distance(a, b) * distance(b, c))
    if (dot < -EPSILON) {
      points.splice(i, 1)
      i--
    }
  }
  const supplied = getAllRoutedTraceCopper(inputSrj, false)
  const index = new RouteSegmentSpatialIndex([
    ...others.flatMap((p) => [
      ...p.segments,
      ...(p.planeEndpointSegments ?? []),
    ]),
    ...supplied.flatMap((p) => p.segments),
  ])
  const vias = [
    ...others.flatMap((p) =>
      [p.via, ...(p.additionalVias ?? []), p.planeEndpointVia].filter(
        (v) => !!v,
      ),
    ),
    ...supplied.flatMap((p) => p.vias),
  ]
  const normalized = normalizeLayeredPath({
    points,
    chamfer: traceWidth / 4,
    segmentIsClear: (a, b) => {
      const segment = {
        start: a,
        end: b,
        layer: layerNames[a.z]!,
        width: traceWidth,
      }
      for (const p of [a, b]) {
        const bounds = bus.sharedBoundary
        if (
          p.x < bounds.minX - EPSILON ||
          p.x > bounds.maxX + EPSILON ||
          p.y < bounds.minY - EPSILON ||
          p.y > bounds.maxY + EPSILON
        )
          return false
        if (
          (Math.abs(p.x - bounds.minX) < EPSILON ||
            Math.abs(p.x - bounds.maxX) < EPSILON ||
            Math.abs(p.y - bounds.minY) < EPSILON ||
            Math.abs(p.y - bounds.maxY) < EPSILON) &&
          distance(p, plan.exitPoint) > EPSILON
        )
          return false
      }
      return (
        inputSrj.obstacles.every(
          (o) =>
            !o.layers.includes(segment.layer) ||
            distanceSegmentToObstacle(segment, o) >=
              traceWidth / 2 + clearance - 1e-9,
        ) &&
        index
          .querySegment(segment, clearance)
          .every((s) => segmentsAreClear(segment, s, clearance)) &&
        vias.every(
          (v) =>
            !v.spanLayers.includes(segment.layer) ||
            distancePointToSegment(v.center, a, b) >=
              (traceWidth + v.diameter) / 2 + clearance - 1e-9,
        )
      )
    },
  })
  if (!normalized) return null
  const route = plan.trace.route.slice(0, firstVia + 1)
  for (let i = 0; i < normalized.length; i++) {
    const point = normalized[i]!,
      previous = normalized[i - 1]
    if (previous && previous.z !== point.z) {
      const via = plan.trace.route.find(
        (p) =>
          p.route_type === "via" &&
          distance(p, point) < EPSILON &&
          p.from_layer === layerNames[previous.z] &&
          p.to_layer === layerNames[point.z],
      )
      if (!via) return null
      route.push(via)
    }
    route.push({
      route_type: "wire",
      x: point.x,
      y: point.y,
      layer: layerNames[point.z]!,
      width: traceWidth,
    })
  }
  route[route.length - 1] = plan.trace.route.at(-1)!
  const trace = { ...plan.trace, route },
    extracted = getRoutedTraceCopper(inputSrj, trace, false).segments
  const sourceCount = plan.sourceEscapeSegmentCount ?? 1
  const segments = [
    ...plan.segments.slice(0, sourceCount),
    ...extracted.slice(sourceCount),
  ]
  if (!changedFanoutCopperIsSelfClear(plan, segments, clearance)) return null
  return {
    ...plan,
    trace,
    segments,
    length: segments.reduce((sum, s) => sum + distance(s.start, s.end), 0),
  }
}

function hasValidTurns(segments: readonly RoutedSegment[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    const dx = segment.end.x - segment.start.x
    const dy = segment.end.y - segment.start.y
    const length = Math.hypot(dx, dy)
    if (
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ) > EPSILON
    )
      return false
    const next = segments[i + 1]
    if (next && distance(segment.end, next.start) > EPSILON) return false
    if (!next || next.layer !== segment.layer || length < EPSILON) continue
    const nx = next.end.x - next.start.x
    const ny = next.end.y - next.start.y
    const nextLength = Math.hypot(nx, ny)
    if (nextLength < EPSILON) continue
    if ((dx * nx + dy * ny) / (length * nextLength) < Math.SQRT1_2 - EPSILON)
      return false
  }
  return true
}

function respectsBoundary(plan: FanoutRoutePlan, bus: PreparedBus): boolean {
  const bounds = bus.sharedBoundary
  return plan.segments.every((segment) =>
    [segment.start, segment.end].every((p) => {
      if (
        p.x < bounds.minX - EPSILON ||
        p.x > bounds.maxX + EPSILON ||
        p.y < bounds.minY - EPSILON ||
        p.y > bounds.maxY + EPSILON
      )
        return false
      if (plan.termination.type !== "boundary") return true
      const onBoundary =
        Math.abs(p.x - bounds.minX) < EPSILON ||
        Math.abs(p.x - bounds.maxX) < EPSILON ||
        Math.abs(p.y - bounds.minY) < EPSILON ||
        Math.abs(p.y - bounds.maxY) < EPSILON
      return !onBoundary || distance(p, plan.exitPoint) < EPSILON
    }),
  )
}

/**
 * Final geometric gate after all tuning. Repair only target-side corners/tails;
 * malformed source prefixes fail closed. Every physical via and exact exit is
 * preserved, and the final original bus skews and full copper DRC still apply.
 */
export function normalizeFanoutPlanCorners(
  params: FinalFanoutPlanNormalizationParams,
): FanoutRoutePlan[] | null {
  const owners = new Map(params.preparedBuses.map((bus) => [bus.busId, bus]))
  if (
    new Set(params.plans.map((p) => p.connectionIndex)).size !==
    params.plans.length
  )
    return null
  let plans = [...params.plans]
  for (const plan of plans) {
    if (!owners.has(plan.busId))
      throw new Error("Final normalization requires each original prepared bus")
    if (
      !hasValidTurns(
        plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1),
      ) ||
      !respectsBoundary(
        {
          ...plan,
          segments: plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1),
        },
        owners.get(plan.busId)!,
      ) ||
      !hasValidTurns(plan.planeEndpointSegments ?? [])
    )
      return null
  }
  if (plans.some((plan) => !respectsBoundary(plan, owners.get(plan.busId)!))) {
    const repaired = repairBoundaryRouteTails({
      ...params,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    })
    if (!repaired) return null
    plans = repaired
  }
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]!
    if (
      hasValidTurns(plan.segments) &&
      respectsBoundary(plan, owners.get(plan.busId)!)
    )
      continue
    const normalized = normalizeFanoutPlanTargetPath(
      params,
      plan,
      plans.filter((_, other) => other !== index),
      owners.get(plan.busId)!,
    )
    if (!normalized) return null
    plans[index] = normalized
  }
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]!
    const original = params.plans.find(
      (p) => p.connectionIndex === plan.connectionIndex,
    )!
    if (
      !original ||
      plan.targetLayer !== original.targetLayer ||
      distance(plan.exitPoint, original.exitPoint) > EPSILON ||
      JSON.stringify(plan.via) !== JSON.stringify(original.via) ||
      JSON.stringify(plan.additionalVias) !==
        JSON.stringify(original.additionalVias) ||
      !hasValidTurns(plan.segments) ||
      !respectsBoundary(plan, owners.get(plan.busId)!)
    )
      return null
    if (plan === original) continue
    const oldVia = original.trace.route.findIndex((p) => p.route_type === "via")
    const newVia = plan.trace.route.findIndex((p) => p.route_type === "via")
    if (oldVia < 0 || newVia < 0) return null
    const count = original.sourceEscapeSegmentCount ?? 1
    plans[index] = {
      ...plan,
      sourcePoint: original.sourcePoint,
      via: original.via,
      additionalVias: original.additionalVias,
      exitPoint: original.exitPoint,
      sourceEscapeSegmentCount: count,
      segments: [
        ...original.segments.slice(0, count),
        ...plan.segments.slice(plan.sourceEscapeSegmentCount ?? 1),
      ],
      trace: {
        ...original.trace,
        route: [
          ...original.trace.route.slice(0, oldVia + 1),
          ...plan.trace.route.slice(newVia + 1),
        ],
      },
    }
  }
  for (const bus of params.preparedBuses) {
    const own = plans.filter((p) => p.busId === bus.busId)
    if (
      own.length !== bus.connections.length ||
      own.some(
        (plan) => !hasValidTurns(plan.segments) || !respectsBoundary(plan, bus),
      )
    )
      return null
    if (bus.maxLengthSkew === undefined) continue
    if (
      Math.max(...own.map((p) => p.length)) -
        Math.min(...own.map((p) => p.length)) >
      bus.maxLengthSkew + EPSILON
    )
      return null
  }
  const validation = validateRoutedCopperDrc({
    inputSrj: params.inputSrj,
    routedSrj: {
      ...params.inputSrj,
      traces: [
        ...(params.inputSrj.traces ?? []),
        ...plans.flatMap((p) => [
          p.trace,
          ...(p.planeEndpointTrace ? [p.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance: params.clearance,
    allowBlindAndBuriedVias: false,
  })
  return validation.valid ? plans : null
}
