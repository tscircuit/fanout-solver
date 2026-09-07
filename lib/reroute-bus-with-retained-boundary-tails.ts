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
import { matchBusPlanLengths } from "./match-bus-lengths"
import { shortcutFanoutPlans } from "./shortcut-fanout-plans"
import { normalizeLayeredPath } from "./normalize-layered-path"
import { fanoutPlansAreClear } from "./route-bus"
import { RouteSegmentSpatialIndex } from "./route-segment-spatial-index"
import {
  routeReservedViaBusesSteps,
  type ReservedViaBusesProgress,
} from "./route-reserved-via-buses"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"

export interface RetainedBoundaryTailRepairParams {
  inputSrj: SimpleRouteJson
  /** Complete physical routing; selected buses may still violate length skew. */
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  busIds?: readonly string[]
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  maximumIterationsPerAttempt?: number
}

export interface RetainedBoundaryTailRepairProgress
  extends ReservedViaBusesProgress {
  busId: string
  phase: "lane" | "bus" | "layer"
}

const EPSILON = 1e-7
const getSkew = (plans: readonly FanoutRoutePlan[]) =>
  Math.max(...plans.map((p) => p.length)) -
  Math.min(...plans.map((p) => p.length))

function retainSource(
  original: FanoutRoutePlan,
  replacement: FanoutRoutePlan,
): FanoutRoutePlan | null {
  const oldVia = original.trace.route.findIndex((p) => p.route_type === "via")
  const newVia = replacement.trace.route.findIndex(
    (p) => p.route_type === "via",
  )
  if (oldVia < 0 || newVia < 0) return null
  const count = original.sourceEscapeSegmentCount ?? 1
  return {
    ...replacement,
    sourcePoint: original.sourcePoint,
    via: original.via,
    exitPoint: original.exitPoint,
    sourceEscapeSegmentCount: count,
    segments: [
      ...original.segments.slice(0, count),
      ...replacement.segments.slice(replacement.sourceEscapeSegmentCount ?? 1),
    ],
    trace: {
      ...original.trace,
      route: [
        ...original.trace.route.slice(0, oldVia + 1),
        ...replacement.trace.route.slice(newVia + 1),
      ],
    },
  }
}

function getRetainedTail(
  plan: FanoutRoutePlan,
  bus: PreparedBus,
  width: number,
): FanoutRoutePlan | null {
  if (!bus.exitEdge || plan.termination.type !== "boundary") return null
  const bounds = bus.sharedBoundary
  const inward = (p: Point2D) =>
    bus.exitEdge === "left"
      ? p.x - bounds.minX
      : bus.exitEdge === "right"
        ? bounds.maxX - p.x
        : bus.exitEdge === "top"
          ? bounds.maxY - p.y
          : p.y - bounds.minY
  if (Math.abs(inward(plan.exitPoint)) > EPSILON) return null
  let first = plan.segments.length - 1
  while (first > 0 && plan.segments[first - 1]!.layer === plan.targetLayer)
    first--
  if (first < (plan.sourceEscapeSegmentCount ?? 1)) return null
  let cutIndex = -1
  for (let i = first; i < plan.segments.length; i++) {
    const segment = plan.segments[i]!
    if (inward(segment.start) >= width && inward(segment.end) <= width)
      cutIndex = i
  }
  if (cutIndex < 0) cutIndex = first
  const segment = plan.segments[cutIndex]!,
    a = inward(segment.start),
    b = inward(segment.end)
  const fraction = a > width && b < a ? (a - width) / (a - b) : 0
  const cut = {
    x: segment.start.x + (segment.end.x - segment.start.x) * fraction,
    y: segment.start.y + (segment.end.y - segment.start.y) * fraction,
  }
  if (inward(cut) <= EPSILON) return null
  const segments = [
    { ...segment, start: cut },
    ...plan.segments.slice(cutIndex + 1),
  ].filter((s) => distance(s.start, s.end) > EPSILON)
  if (!segments.length || segments.some((s) => s.layer !== plan.targetLayer))
    return null
  return {
    ...plan,
    sourcePoint: { ...plan.sourcePoint, ...cut },
    sourceEscapeSegmentCount: 0,
    via: undefined,
    additionalVias: [],
    segments,
    length: segments.reduce((sum, s) => sum + distance(s.start, s.end), 0),
    trace: {
      ...plan.trace,
      pcb_trace_id: `${plan.trace.pcb_trace_id}-retained-tail`,
      route: [cut, ...segments.map((s) => s.end)].map((p) => ({
        route_type: "wire" as const,
        ...p,
        layer: plan.targetLayer,
        width: segments[0]!.width,
      })),
    },
  }
}

/** Normalize the new join, retaining the actual source prefix and every via. */
function normalizeJoinedPlan(
  params: RetainedBoundaryTailRepairParams,
  plan: FanoutRoutePlan,
  others: readonly FanoutRoutePlan[],
  bus: PreparedBus,
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
  for (let i = 1; i < points.length - 1; i++) {
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
  return {
    ...plan,
    trace,
    segments,
    length: segments.reduce((sum, s) => sum + distance(s.start, s.end), 0),
  }
}

function getSourceReservations(params: RetainedBoundaryTailRepairParams) {
  const { inputSrj, preparedBuses, layerNames, viaDiameter, viaHoleDiameter } =
    params
  const byIndex = new Map(params.plans.map((p) => [p.connectionIndex, p]))
  const connections = preparedBuses.flatMap((b) => b.connections)
  if (
    connections.length !== inputSrj.connections.length ||
    byIndex.size !== connections.length ||
    byIndex.size !== params.plans.length ||
    connections.some(
      (c) =>
        byIndex.get(c.connectionIndex)?.connectionName !== c.connection.name,
    )
  )
    throw new Error(
      "Retained-tail repair requires every original connection exactly once",
    )
  const fixed = new Map<number, Point2D>(),
    sourcePaths = new Map<number, readonly Point2D[]>()
  for (const c of connections) {
    const p = byIndex.get(c.connectionIndex)!,
      source = p.segments.slice(0, p.sourceEscapeSegmentCount ?? 1)
    if (
      !p.via ||
      !source.length ||
      source.some((s) => s.layer !== c.sourceLayer) ||
      distance(source[0]!.start, c.sourcePoint) > EPSILON ||
      distance(source.at(-1)!.end, p.via.center) > EPSILON ||
      source.some(
        (s, i) => i > 0 && distance(source[i - 1]!.end, s.start) > EPSILON,
      ) ||
      p.via.fromLayer !== c.sourceLayer ||
      p.via.toLayer !== p.targetLayer ||
      p.via.diameter !== viaDiameter ||
      p.via.holeDiameter !== viaHoleDiameter ||
      p.via.spanLayers.length !== layerNames.length ||
      !layerNames.every((l) => p.via!.spanLayers.includes(l))
    )
      return null
    fixed.set(c.connectionIndex, p.via.center)
    sourcePaths.set(c.connectionIndex, [
      source[0]!.start,
      ...source.map((s) => s.end),
    ])
  }
  return { fixed, sourcePaths }
}

/**
 * Repair an intact bus whose nested routing or clipped terminal cells prevent
 * shorter individual paths. Its valid boundary tails remain reserved while
 * the bus is rerouted to interior cuts. Every source, other bus and supplied
 * trace stays fixed; only complete buses satisfying the original skew return.
 */
function* rerouteIndividualBusesSteps(
  params: RetainedBoundaryTailRepairParams,
): Generator<RetainedBoundaryTailRepairProgress, FanoutRoutePlan[] | null> {
  const {
    inputSrj,
    preparedBuses,
    layerNames,
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
  } = params
  const maximumIterations = params.maximumIterationsPerAttempt ?? 10_000_000
  if (!Number.isSafeInteger(maximumIterations) || maximumIterations < 1)
    throw new Error(
      "maximumIterationsPerAttempt must be a positive safe integer",
    )
  const sources = getSourceReservations(params)
  if (!sources) return null
  const { fixed, sourcePaths } = sources
  let plans = [...params.plans]
  const selected = preparedBuses.filter(
    (b) =>
      b.termination.type === "boundary" &&
      b.maxLengthSkew !== undefined &&
      b.connections.length > 1 &&
      (!params.busIds || params.busIds.includes(b.busId)),
  )
  for (const bus of selected) {
    const own = plans.filter((p) => p.busId === bus.busId)
    if (own.length !== bus.connections.length) return null
    if (getSkew(own) <= bus.maxLengthSkew! + EPSILON) continue
    const targetLayer = own[0]!.targetLayer
    if (
      own.some(
        (p) =>
          p.targetLayer !== targetLayer ||
          p.planeEndpointTrace ||
          p.planeEndpointSegments ||
          p.planeEndpointVia,
      ) ||
      !bus.exitEdge
    )
      return null
    const permitted = (
      bus.routableEscapeLayers ??
      bus.allowedLayers ??
      layerNames
    ).filter((l) => (bus.allowedLayers ?? layerNames).includes(l))
    if (!permitted.includes(targetLayer)) return null
    const transitLayers = permitted.filter((l) => l !== targetLayer)
    if (!transitLayers.length) return null
    const route = (
      selected: PreparedBus["connections"],
      exits: ReadonlyMap<number, Point2D>,
      acceptedPlans: readonly FanoutRoutePlan[],
    ) => {
      const routingParams = {
        srj: inputSrj,
        allBuses: preparedBuses,
        buses: [{ ...bus, connections: selected }],
        targetLayer,
        transitLayers,
        terminals: selected.map((connection) => ({
          connection,
          viaPoint: fixed.get(connection.connectionIndex)!,
          exitPoint: exits.get(connection.connectionIndex)!,
        })),
        fixedViaPointsByConnectionIndex: fixed,
        sourceEscapePaths: sourcePaths,
        acceptedPlans,
        layerNames,
        traceWidth,
        clearance,
        viaDiameter,
        viaHoleDiameter,
        tightViaChannels: true,
        includeDiagonalNeighbors: true,
        heuristicWeight: 1,
        maximumIterations,
        maximumRipEvents: 200,
        maximumLocalRepairAttempts: 0,
        ripCost: 256,
        shuffleSeed: 1,
      }
      return routeReservedViaBusesSteps(routingParams)
    }
    const longest = own.toSorted((a, b) => b.length - a.length)[0]!
    const connection = bus.connections.find(
      (c) => c.connectionIndex === longest.connectionIndex,
    )!
    const single = route(
      [connection],
      new Map([[longest.connectionIndex, longest.exitPoint]]),
      plans.filter((p) => p !== longest),
    )
    let next = single.next()
    while (!next.done) {
      yield { ...next.value, busId: bus.busId, phase: "lane" }
      next = single.next()
    }
    const lane = next.value?.[0] ? retainSource(longest, next.value[0]) : null
    if (
      lane &&
      getSkew(own.map((p) => (p === longest ? lane : p))) <=
        bus.maxLengthSkew! + EPSILON
    ) {
      plans = plans.map((p) => (p === longest ? lane : p))
      continue
    }
    const tailWidth = Math.min(
      12 * (traceWidth + clearance),
      (bus.exitEdge === "left" || bus.exitEdge === "right"
        ? bus.sharedBoundary.maxX - bus.sharedBoundary.minX
        : bus.sharedBoundary.maxY - bus.sharedBoundary.minY) / 3,
    )
    const tails = own.map((p) => getRetainedTail(p, bus, tailWidth))
    if (tails.some((p) => !p)) return null
    const retained = tails as FanoutRoutePlan[],
      others = plans.filter((p) => p.busId !== bus.busId)
    const joint = route(
      bus.connections,
      new Map(retained.map((p) => [p.connectionIndex, p.sourcePoint])),
      [...others, ...retained],
    )
    let group = joint.next()
    while (!group.done) {
      yield { ...group.value, busId: bus.busId, phase: "bus" }
      group = joint.next()
    }
    if (!group.value || group.value.length !== own.length) return null
    let combined = plans.map((original) => {
      const routed = group.value!.find(
        (p) => p.connectionIndex === original.connectionIndex,
      )
      if (!routed) return original
      const p = retainSource(original, routed)
      if (!p) throw new Error("Retained-tail routing lost its source via")
      const tail = retained.find(
          (t) => t.connectionIndex === p.connectionIndex,
        )!,
        route = [...p.trace.route, ...tail.trace.route.slice(1)]
      route[route.length - 1] = original.trace.route.at(-1)!
      return {
        ...p,
        exitPoint: original.exitPoint,
        trace: { ...original.trace, route },
        segments: [...p.segments, ...tail.segments],
        length: p.length + tail.length,
      }
    })
    for (const original of own) {
      const candidate = combined.find(
        (p) => p.connectionIndex === original.connectionIndex,
      )!
      const normalized = normalizeJoinedPlan(
        params,
        candidate,
        combined.filter((p) => p !== candidate),
        bus,
      )
      if (!normalized) return null
      combined = combined.map((p) => (p === candidate ? normalized : p))
    }
    if (
      getSkew(combined.filter((p) => p.busId === bus.busId)) >
        bus.maxLengthSkew! + EPSILON ||
      !fanoutPlansAreClear({
        plans: combined,
        srj: inputSrj,
        sharedBoundary: bus.sharedBoundary,
        clearance,
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: false,
      })
    )
      return null
    plans = combined
  }
  const validation = validateRoutedCopperDrc({
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
  })
  return validation.valid ? plans : null
}

/** Try neighboring buses together only after individual cleanup is exhausted. */
export function* rerouteBusWithRetainedBoundaryTailsSteps(
  params: RetainedBoundaryTailRepairParams,
): Generator<RetainedBoundaryTailRepairProgress, FanoutRoutePlan[] | null> {
  const individual = yield* rerouteIndividualBusesSteps(params)
  if (individual) return individual
  const reservations = getSourceReservations(params)
  if (!reservations) return null
  const { fixed, sourcePaths } = reservations
  const { inputSrj, preparedBuses, layerNames, traceWidth, clearance } = params
  const selected = preparedBuses.filter(
    (bus) =>
      bus.termination.type === "boundary" &&
      bus.connections.length > 1 &&
      bus.maxLengthSkew !== undefined &&
      (!params.busIds || params.busIds.includes(bus.busId)),
  )
  const groups = new Map<string, PreparedBus[]>()
  for (const bus of selected) {
    const own = params.plans.filter((p) => p.busId === bus.busId)
    if (own.length !== bus.connections.length || !bus.exitEdge) return null
    const layer = own[0]!.targetLayer
    if (
      own.some(
        (p) =>
          p.targetLayer !== layer ||
          p.planeEndpointTrace ||
          p.planeEndpointSegments ||
          p.planeEndpointVia,
      )
    )
      return null
    const key = `${layer}:${bus.exitEdge}`
    groups.set(key, [...(groups.get(key) ?? []), bus])
  }
  let plans = [...params.plans]
  for (const buses of groups.values()) {
    const ids = new Set(buses.map((bus) => bus.busId))
    const own = plans.filter((p) => ids.has(p.busId))
    if (
      buses.every(
        (bus) =>
          getSkew(own.filter((p) => p.busId === bus.busId)) <=
          bus.maxLengthSkew! + EPSILON,
      )
    )
      continue
    if (buses.length < 2) return null
    const targetLayer = own[0]!.targetLayer
    const permitted = layerNames.filter((layer) =>
      buses.every(
        (bus) =>
          (
            bus.routableEscapeLayers ??
            bus.allowedLayers ??
            layerNames
          ).includes(layer) &&
          (bus.allowedLayers ?? layerNames).includes(layer),
      ),
    )
    if (!permitted.includes(targetLayer)) return null
    const transitLayers = permitted.filter((layer) => layer !== targetLayer)
    if (!transitLayers.length) return null
    const bounds = buses[0]!.sharedBoundary
    const tailWidth = Math.min(
      12 * (traceWidth + clearance),
      (buses[0]!.exitEdge === "left" || buses[0]!.exitEdge === "right"
        ? bounds.maxX - bounds.minX
        : bounds.maxY - bounds.minY) / 3,
    )
    const tails = own.map((plan) =>
      getRetainedTail(
        plan,
        buses.find((bus) => bus.busId === plan.busId)!,
        tailWidth,
      ),
    )
    if (tails.some((tail) => !tail)) return null
    const retained = tails as FanoutRoutePlan[]
    const others = plans.filter((plan) => !ids.has(plan.busId))
    const steps = routeReservedViaBusesSteps({
      ...params,
      srj: inputSrj,
      allBuses: preparedBuses,
      buses,
      targetLayer,
      transitLayers,
      terminals: buses.flatMap((bus) =>
        bus.connections.map((connection) => ({
          connection,
          viaPoint: fixed.get(connection.connectionIndex)!,
          exitPoint: retained.find(
            (tail) => tail.connectionIndex === connection.connectionIndex,
          )!.sourcePoint,
        })),
      ),
      fixedViaPointsByConnectionIndex: fixed,
      sourceEscapePaths: sourcePaths,
      acceptedPlans: [...others, ...retained],
      tightViaChannels: true,
      includeDiagonalNeighbors: true,
      heuristicWeight: 1,
      // A lower rip penalty lets neighboring lanes negotiate instead of
      // accepting a long detour merely to preserve an earlier provisional path.
      ripCost: 8,
      shuffleSeed: 1,
      maximumIterations: params.maximumIterationsPerAttempt ?? 10_000_000,
      maximumRipEvents: 200,
      maximumLocalRepairAttempts: 0,
    })
    let next = steps.next()
    while (!next.done) {
      yield { ...next.value, busId: buses[0]!.busId, phase: "layer" }
      next = steps.next()
    }
    if (!next.value || next.value.length !== own.length) return null
    const routed = next.value
    let combined = plans.map((original) => {
      const replacement = routed.find(
        (p) => p.connectionIndex === original.connectionIndex,
      )
      if (!replacement) return original
      const plan = retainSource(original, replacement)
      if (!plan)
        throw new Error("Joint retained-tail routing lost its source via")
      const tail = retained.find(
        (p) => p.connectionIndex === original.connectionIndex,
      )!
      const route = [...plan.trace.route, ...tail.trace.route.slice(1)]
      route[route.length - 1] = original.trace.route.at(-1)!
      return {
        ...plan,
        trace: { ...original.trace, route },
        segments: [...plan.segments, ...tail.segments],
        length: plan.length + tail.length,
      }
    })
    for (const original of own) {
      const candidate = combined.find(
        (p) => p.connectionIndex === original.connectionIndex,
      )!
      const normalized = normalizeJoinedPlan(
        params,
        candidate,
        combined.filter((p) => p !== candidate),
        buses.find((bus) => bus.busId === original.busId)!,
      )
      if (!normalized) return null
      combined = combined.map((p) => (p === candidate ? normalized : p))
    }
    if (
      !fanoutPlansAreClear({
        plans: combined,
        srj: inputSrj,
        sharedBoundary: bounds,
        clearance,
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: false,
      })
    )
      return null
    combined =
      shortcutFanoutPlans({
        ...params,
        plans: combined,
        preparedBuses: buses,
        selectedBusIds: ids,
        allowBlindAndBuriedVias: false,
      }) ?? combined
    const matched = matchBusPlanLengths({
      ...params,
      plans: combined,
      preparedBuses: buses,
      sharedBoundary: bounds,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
      allowMatchingInsideDenseBounds: true,
      allowPairLaneSpreading: true,
      allowUnconstrainedLaneRerouting: true,
      maximumWorkUnits: 1_000,
    })
    if (!matched.plans) return null
    // Tuning may reconstruct segment metadata. Restore the exact original
    // source objects and leave every unrelated complete plan untouched.
    const tuned = matched.plans
    combined = plans.map((original) => {
      if (!ids.has(original.busId)) return original
      const plan = tuned.find(
        (p) => p.connectionIndex === original.connectionIndex,
      )!
      const restored = retainSource(original, plan)
      if (!restored)
        throw new Error("Joint retained-tail tuning lost its source via")
      return restored
    })
    if (
      buses.some(
        (bus) =>
          getSkew(combined.filter((p) => p.busId === bus.busId)) >
          bus.maxLengthSkew! + EPSILON,
      )
    )
      return null
    plans = combined
  }
  if (
    selected.some(
      (bus) =>
        getSkew(plans.filter((p) => p.busId === bus.busId)) >
        bus.maxLengthSkew! + EPSILON,
    )
  )
    return null
  const validation = validateRoutedCopperDrc({
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
  })
  return validation.valid ? plans : null
}
