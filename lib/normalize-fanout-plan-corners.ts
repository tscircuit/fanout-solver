import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToSegment,
  distancePointToObstacle,
  distanceSegmentToObstacle,
  segmentsAreClear,
  pointIsInsideObstacle,
} from "./geometry"
import {
  getAllRoutedTraceCopper,
  getRoutedTraceCopper,
} from "./get-routed-trace-copper"
import { getDeclaredDifferentialPairs } from "./get-declared-differential-pairs"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "./net-identity"
import { normalizeLayeredPath } from "./normalize-layered-path"
import { repairBoundaryRouteTails } from "./repair-boundary-route-tails"
import { RouteSegmentSpatialIndex } from "./route-segment-spatial-index"
import { createFanoutPlanClearanceValidator } from "./route-bus"
import type { FanoutRoutePlan, PreparedBus, RoutedSegment } from "./types"
import {
  segmentIsLegalTerminalBodyEscape,
  validateRoutedCopperDrc,
} from "./validate-routed-copper-drc"

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
  /** Repair source-only plane drops with no separate endpoint copper. */
  repairPlaneSourceCorners?: boolean
  /** Repair signal source prefixes while retaining every via and target segment. */
  repairSignalSourceCorners?: boolean
  /** Restore original bus/pair limits after boundary or corner cleanup. */
  rematchRepairedLengths?: (
    plans: readonly FanoutRoutePlan[],
  ) => FanoutRoutePlan[] | null
}
const EPSILON = 1e-7

function plansSatisfyLengthConstraints(params: {
  inputSrj: SimpleRouteJson
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
}): boolean {
  for (const bus of params.preparedBuses) {
    if (bus.maxLengthSkew === undefined) continue
    const busPlans = params.plans.filter((plan) => plan.busId === bus.busId)
    if (busPlans.length !== bus.connections.length) return false
    const lengths = busPlans.map((plan) => plan.length)
    if (
      Math.max(...lengths) - Math.min(...lengths) >
      bus.maxLengthSkew + EPSILON
    )
      return false
  }
  const plansByConnection = new Map(
    params.plans.map((plan) => [plan.connectionIndex, plan]),
  )
  for (const pair of getDeclaredDifferentialPairs(params.inputSrj)) {
    const pairPlans = pair.connectionIndices.map((connectionIndex) =>
      plansByConnection.get(connectionIndex),
    )
    const [firstPlan, secondPlan] = pairPlans
    if (!firstPlan || !secondPlan) continue
    const lengths = [firstPlan, secondPlan].map((plan) =>
      [...plan.segments, ...(plan.planeEndpointSegments ?? [])].reduce(
        (total, segment) => total + distance(segment.start, segment.end),
        0,
      ),
    )
    if (
      lengths.some((length) => !Number.isFinite(length)) ||
      Math.abs(lengths[0]! - lengths[1]!) > pair.lengthTolerance + EPSILON
    )
      return false
  }
  return true
}

/** Check new copper without reinterpreting retained runs as one replaced edge. */
export function changedFanoutCopperIsSelfClear(
  plan: FanoutRoutePlan,
  segments: readonly RoutedSegment[],
  clearance: number,
  changedSegmentIndices?: ReadonlySet<number>,
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
    if (changedSegmentIndices && !changedSegmentIndices.has(index)) continue
    // Splitting or trimming an original straight run introduces no copper.
    if (
      !changedSegmentIndices &&
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
  chamfer = params.traceWidth / 4,
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
    chamfer,
    repairReversingDiagonalCorners: true,
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

/** Repair a source prefix without moving its first via or subsequent copper. */
function normalizePlaneSourcePath(
  params: FinalFanoutPlanNormalizationParams,
  plan: FanoutRoutePlan,
  others: readonly FanoutRoutePlan[],
  bus: PreparedBus,
  signalSource = false,
): FanoutRoutePlan | null {
  const sourceCount = plan.sourceEscapeSegmentCount ?? 1
  if (
    plan.termination.type !== (signalSource ? "boundary" : "plane") ||
    !plan.via ||
    (!signalSource && plan.additionalVias?.length) ||
    plan.planeEndpointTrace ||
    plan.planeEndpointSegments?.length ||
    plan.planeEndpointVia ||
    (!signalSource && plan.segments.length !== sourceCount)
  )
    return null
  const sourceSegments = plan.segments.slice(0, sourceCount)
  if (
    !sourceSegments.length ||
    sourceSegments.some((s) => s.layer !== plan.sourceLayer) ||
    distance(sourceSegments[0]!.start, plan.sourcePoint) > EPSILON ||
    distance(sourceSegments.at(-1)!.end, plan.via.center) > EPSILON
  )
    return null
  const source = bus.connections.find(
    (c) => c.connectionIndex === plan.connectionIndex,
  )
  if (!source?.sourceObstacle) return null
  const firstVia = plan.trace.route.findIndex((p) => p.route_type === "via")
  if (firstVia < 1) return null
  const { inputSrj, traceWidth, clearance, layerNames } = params
  // Plane drops are already joined by their declared plane. Preserve the
  // routing stage's permission to reuse that net's existing copper, while
  // keeping signal branches and the plan's own returning arms separate.
  const sharesPlaneNet = (connectionName: string): boolean =>
    plan.termination.type === "plane" &&
    connectionsShareElectricalNet(inputSrj, plan.connectionName, connectionName)
  const blockingPlans = others.filter(
    (other) =>
      other.termination.type !== "plane" ||
      !sharesPlaneNet(other.connectionName),
  )
  const supplied = getAllRoutedTraceCopper(inputSrj, false).filter(
    (copper) => !sharesPlaneNet(copper.connectionName),
  )
  const index = new RouteSegmentSpatialIndex([
    ...plan.segments.slice(sourceCount),
    ...blockingPlans.flatMap((p) => [
      ...p.segments,
      ...(p.planeEndpointSegments ?? []),
    ]),
    ...supplied.flatMap((p) => p.segments),
  ])
  const vias = [
    ...(plan.additionalVias ?? []),
    ...blockingPlans.flatMap((p) =>
      [p.via, ...(p.additionalVias ?? []), p.planeEndpointVia].filter(
        (v) => !!v,
      ),
    ),
    ...supplied.flatMap((p) => p.vias),
  ]
  const normalized = normalizeLayeredPath({
    points: [plan.sourcePoint, ...sourceSegments.map((s) => s.end)].map(
      (p) => ({
        ...p,
        z: layerNames.indexOf(plan.sourceLayer),
      }),
    ),
    chamfer: traceWidth / 4,
    repairReversingDiagonalCorners: true,
    segmentIsClear: (a, b) => {
      const segment = {
        start: a,
        end: b,
        layer: plan.sourceLayer,
        width: traceWidth,
      }
      const boundary = bus.sharedBoundary
      if (
        [a, b].some(
          (p) =>
            p.x < boundary.minX ||
            p.x > boundary.maxX ||
            p.y < boundary.minY ||
            p.y > boundary.maxY,
        )
      )
        return false
      return (
        inputSrj.obstacles.every((obstacle) => {
          if (!obstacle.layers.includes(plan.sourceLayer)) return true
          if (
            distanceSegmentToObstacle(segment, obstacle) >=
            traceWidth / 2 + clearance - 1e-9
          )
            return true
          // Permit only the connected, outward-moving lead from the original pad.
          // Later source-layer copper receives no renewed source-pad exemption.
          if (
            obstacle === source.sourceObstacle &&
            pointIsInsideObstacle(a, obstacle, traceWidth / 2 + clearance) &&
            (a.x - source.sourcePoint.x) * (b.x - a.x) +
              (a.y - source.sourcePoint.y) * (b.y - a.y) >=
              -EPSILON
          )
            return true
          if (
            obstacle !== source.sourceObstacle &&
            plan.termination.type === "plane" &&
            obstacleSharesElectricalNet(inputSrj, obstacle, plan.connectionName)
          )
            return true
          return segmentIsLegalTerminalBodyEscape({
            inputSrj,
            segment,
            bodyObstacle: obstacle,
            connectionName: plan.connectionName,
          })
        }) &&
        index
          .querySegment(segment, clearance)
          .every((other) => segmentsAreClear(segment, other, clearance)) &&
        vias.every(
          (via) =>
            !via.spanLayers.includes(segment.layer) ||
            distancePointToSegment(via.center, a, b) >=
              (traceWidth + via.diameter) / 2 + clearance - 1e-9,
        )
      )
    },
  })
  if (!normalized) return null
  const trace = {
    ...plan.trace,
    route: [
      plan.trace.route[0]!,
      ...normalized.slice(1).map((p) => ({
        route_type: "wire" as const,
        x: p.x,
        y: p.y,
        layer: plan.sourceLayer,
        width: traceWidth,
      })),
      ...plan.trace.route.slice(firstVia),
    ],
  }
  const prefix = getRoutedTraceCopper(
    inputSrj,
    { ...trace, route: trace.route.slice(0, normalized.length) },
    false,
  ).segments
  const segments = [...prefix, ...plan.segments.slice(sourceCount)]
  let leftSourcePad = false
  for (const segment of prefix) {
    const clearanceToPad = distanceSegmentToObstacle(
      segment,
      source.sourceObstacle,
    )
    if (leftSourcePad && clearanceToPad < traceWidth / 2 + clearance - 1e-9)
      return null
    if (
      distancePointToObstacle(segment.end, source.sourceObstacle) >=
      traceWidth / 2 + clearance - 1e-9
    )
      leftSourcePad = true
  }
  if (
    !hasValidTurns(prefix) ||
    !changedFanoutCopperIsSelfClear(
      plan,
      segments,
      clearance,
      new Set(prefix.map((_, index) => index)),
    )
  )
    return null
  return {
    ...plan,
    trace,
    segments,
    sourceEscapeSegmentCount: prefix.length,
    length: [...segments, ...(plan.planeEndpointSegments ?? [])].reduce(
      (total, s) => total + distance(s.start, s.end),
      0,
    ),
  }
}

/**
 * Final geometric gate after all tuning. Source prefixes are preserved unless
 * source repair is explicitly requested. Every physical via and exact
 * exit is retained, and original length limits and full copper DRC still apply.
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
  let repairedSourceCorners = false
  if (params.repairPlaneSourceCorners || params.repairSignalSourceCorners) {
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index]!
      if (
        hasValidTurns(
          plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1),
        )
      )
        continue
      const owner = owners.get(plan.busId)
      if (!owner) return null
      if (
        plan.termination.type === "plane"
          ? !params.repairPlaneSourceCorners
          : !params.repairSignalSourceCorners
      )
        return null
      const normalized = normalizePlaneSourcePath(
        params,
        plan,
        plans.filter((_, other) => other !== index),
        owner,
        plan.termination.type === "boundary",
      )
      if (!normalized) return null
      plans[index] = normalized
      repairedSourceCorners = true
    }
  }
  if (
    repairedSourceCorners &&
    params.rematchRepairedLengths &&
    !plansSatisfyLengthConstraints({
      inputSrj: params.inputSrj,
      plans,
      preparedBuses: params.preparedBuses,
    })
  ) {
    const rematched = params.rematchRepairedLengths(plans)
    if (!rematched) return null
    plans = rematched
  }
  const sourceNormalizedPlans = [...plans]
  const pairs = getDeclaredDifferentialPairs(params.inputSrj)
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
      plans,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    })
    if (!repaired) return null
    plans = repaired
    // Removing an early boundary run can shorten one lane enough to invalidate
    // an already matched bus. Restore its length before selecting chamfers;
    // final geometry, physical-via, and measured-skew checks still apply below.
    if (params.rematchRepairedLengths) {
      const rematched = params.rematchRepairedLengths(plans)
      if (!rematched) return null
      plans = rematched
    }
  }
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]!
    if (
      hasValidTurns(plan.segments) &&
      respectsBoundary(plan, owners.get(plan.busId)!)
    )
      continue
    const bus = owners.get(plan.busId)!
    let normalized: FanoutRoutePlan | null = null
    let clearCandidate: FanoutRoutePlan | null = null
    // Try progressively smaller chamfers to preserve an already matched bus.
    // Sub-grid stubs can have less remaining length slack than the trace width.
    for (
      let chamfer = params.traceWidth / 4;
      chamfer >= 1e-6;
      chamfer = Math.max(1e-6, chamfer / 4)
    ) {
      const candidate = normalizeFanoutPlanTargetPath(
        params,
        plan,
        plans.filter((_, other) => other !== index),
        bus,
        false,
        chamfer,
      )
      if (candidate) {
        clearCandidate ??= candidate
        const own = plans
          .filter((p) => p.busId === bus.busId)
          .map((p) => (p === plan ? candidate.length : p.length))
        const pairsAreMatched = pairs.every((pair) => {
          if (!pair.connectionIndices.includes(plan.connectionIndex))
            return true
          const pairPlans = pair.connectionIndices.map((connectionIndex) =>
            plans.find((p) => p.connectionIndex === connectionIndex),
          )
          if (pairPlans.some((p) => !p)) return true
          const lengths = pairPlans.map((p) =>
            p === plan ? candidate.length : p!.length,
          )
          return (
            Math.abs(lengths[0]! - lengths[1]!) <=
            pair.lengthTolerance + EPSILON
          )
        })
        if (
          pairsAreMatched &&
          (bus.maxLengthSkew === undefined ||
            Math.max(...own) - Math.min(...own) <= bus.maxLengthSkew + EPSILON)
        ) {
          normalized = candidate
          break
        }
      }
      if (chamfer === 1e-6) break
    }
    // Several corners can consume even the smallest remaining matched-length
    // margin. Use a clear normal-sized chamfer and physically retune the bus,
    // rather than accepting excess skew or sub-tolerance corner geometry.
    if (!normalized && clearCandidate && params.rematchRepairedLengths) {
      const rematched = params.rematchRepairedLengths(
        plans.map((p, candidateIndex) =>
          candidateIndex === index ? clearCandidate! : p,
        ),
      )
      const repaired = rematched?.find(
        (p) => p.connectionIndex === plan.connectionIndex,
      )
      if (rematched && repaired && hasValidTurns(repaired.segments)) {
        plans = rematched
        normalized = repaired
      }
    }
    if (!normalized) return null
    plans[index] = normalized
  }
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]!
    const original = sourceNormalizedPlans.find(
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
  const plansByConnection = new Map(
    plans.map((plan) => [plan.connectionIndex, plan]),
  )
  for (const pair of pairs) {
    const pairPlans = pair.connectionIndices.map((index) =>
      plansByConnection.get(index),
    )
    // This helper also normalizes complete bus subsets before the rest route.
    if (pairPlans.some((plan) => !plan)) continue
    const lengths = pairPlans.map((plan) =>
      [...plan!.segments, ...(plan!.planeEndpointSegments ?? [])].reduce(
        (total, segment) => total + distance(segment.start, segment.end),
        0,
      ),
    )
    if (
      lengths.some((length) => !Number.isFinite(length)) ||
      Math.abs(lengths[0]! - lengths[1]!) > pair.lengthTolerance + EPSILON
    )
      return null
  }
  // Supplied traces may belong to a completed earlier routing phase whose
  // connection names are absent from this input. Keep unrelated or unknown
  // copper hard; only declared plane nets may reuse their existing copper.
  if (params.inputSrj.traces?.length && plans.length) {
    const bounds = params.preparedBuses.map((bus) => bus.sharedBoundary)
    const clear = createFanoutPlanClearanceValidator({
      srj: params.inputSrj,
      sharedBoundary: {
        minX: Math.min(...bounds.map((b) => b.minX)),
        maxX: Math.max(...bounds.map((b) => b.maxX)),
        minY: Math.min(...bounds.map((b) => b.minY)),
        maxY: Math.max(...bounds.map((b) => b.maxY)),
      },
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetPlaneMerges: true,
    })
    if (!clear(plans)) return null
  }
  const validation = validateRoutedCopperDrc({
    inputSrj: params.inputSrj,
    routedSrj: {
      ...params.inputSrj,
      traces: [
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
