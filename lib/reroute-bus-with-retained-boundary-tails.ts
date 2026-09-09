import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distance } from "./geometry"
import { matchBusPlanLengths } from "./match-bus-lengths"
import { shortcutFanoutPlans } from "./shortcut-fanout-plans"
import { normalizeFanoutPlanTargetPath } from "./normalize-fanout-plan-corners"
import { fanoutPlansAreClear } from "./route-bus"
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
  phase: "lane" | "bus" | "layer" | "overlong-pair"
}

interface ShortenedSingleton {
  busId: string
  plan: FanoutRoutePlan
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
  shortened: ShortenedSingleton[],
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
      lane.length < longest.length - EPSILON &&
      getSkew(own.map((p) => (p === longest ? lane : p))) <
        getSkew(own) - EPSILON
    )
      shortened.push({ busId: bus.busId, plan: lane })
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
      const normalized = normalizeFanoutPlanTargetPath(
        params,
        candidate,
        combined.filter((p) => p !== candidate),
        bus,
        true,
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
function* rerouteExistingBoundaryTailsSteps(
  params: RetainedBoundaryTailRepairParams,
  shortened: ShortenedSingleton[],
): Generator<RetainedBoundaryTailRepairProgress, FanoutRoutePlan[] | null> {
  const individual = yield* rerouteIndividualBusesSteps(params, shortened)
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
      const normalized = normalizeFanoutPlanTargetPath(
        params,
        candidate,
        combined.filter((p) => p !== candidate),
        buses.find((bus) => bus.busId === original.busId)!,
        true,
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

/** Reuse shorter singleton routes only after the existing repair paths fail. */
function* rerouteExistingAndShortenedBoundaryTailsSteps(
  params: RetainedBoundaryTailRepairParams,
): Generator<RetainedBoundaryTailRepairProgress, FanoutRoutePlan[] | null> {
  const shortened: ShortenedSingleton[] = []
  const existing = yield* rerouteExistingBoundaryTailsSteps(params, shortened)
  if (existing) return existing
  if (!shortened.length) return null
  let plans = [...params.plans]
  let accepted = false
  for (const { busId, plan } of shortened) {
    const bus = params.preparedBuses.find((b) => b.busId === busId)!
    const original = plans.find(
      (p) => p.connectionIndex === plan.connectionIndex,
    )!
    const normalized = normalizeFanoutPlanTargetPath(
      params,
      plan,
      plans.filter((p) => p !== original),
      bus,
      true,
    )
    if (!normalized) continue
    const candidate = plans.map((p) => (p === original ? normalized : p))
    // Shortening can create enough tuning room even when the raw lane still
    // exceeds its bus limit. Commit only a complete, matched physical bus.
    const matched = matchBusPlanLengths({
      ...params,
      plans: candidate,
      preparedBuses: [bus],
      sharedBoundary: bus.sharedBoundary,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
      allowMatchingInsideDenseBounds: true,
      allowPairLaneSpreading: true,
      allowUnconstrainedLaneRerouting: true,
      maximumWorkUnits: 1_000,
    })
    if (!matched.plans) continue
    const restored = plans.map((previous) => {
      if (previous.busId !== busId) return previous
      const tuned = matched.plans!.find(
        (p) => p.connectionIndex === previous.connectionIndex,
      )!
      return retainSource(previous, tuned)
    })
    if (restored.some((p) => !p)) continue
    const complete = restored as FanoutRoutePlan[]
    if (
      getSkew(complete.filter((p) => p.busId === busId)) >
        bus.maxLengthSkew! + EPSILON ||
      !fanoutPlansAreClear({
        plans: complete,
        srj: params.inputSrj,
        sharedBoundary: bus.sharedBoundary,
        clearance: params.clearance,
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: false,
      })
    )
      continue
    plans = complete
    accepted = true
  }
  if (!accepted) return null
  if (
    params.preparedBuses.some(
      (bus) =>
        (!params.busIds || params.busIds.includes(bus.busId)) &&
        bus.maxLengthSkew !== undefined &&
        getSkew(plans.filter((p) => p.busId === bus.busId)) >
          bus.maxLengthSkew + EPSILON,
    )
  )
    return null
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

export { getRetainedTail as getRetainedBoundaryTail }

/**
 * Two long lanes can fence each other out of a shorter transit corridor.
 * Reconsider only those lanes together, keeping all other copper and every
 * original first via fixed. Return only after the intact bus matches.
 */
export function* rerouteTwoOverlongLanesSteps(
  params: RetainedBoundaryTailRepairParams,
): Generator<RetainedBoundaryTailRepairProgress, FanoutRoutePlan[] | null> {
  const sources = getSourceReservations(params)
  if (!sources) return null
  const { inputSrj, preparedBuses, layerNames } = params
  const requestedIterations = params.maximumIterationsPerAttempt ?? 5_000_000
  if (!Number.isSafeInteger(requestedIterations) || requestedIterations < 1)
    throw new Error(
      "maximumIterationsPerAttempt must be a positive safe integer",
    )
  const maximumIterations = Math.min(requestedIterations, 5_000_000)
  const selectedBuses = preparedBuses.filter(
    (bus) =>
      bus.termination.type === "boundary" &&
      bus.connections.length > 2 &&
      bus.maxLengthSkew !== undefined &&
      (!params.busIds || params.busIds.includes(bus.busId)),
  )
  let plans = [...params.plans]
  let repairedAny = false
  for (const bus of selectedBuses) {
    const own = plans.filter((plan) => plan.busId === bus.busId)
    if (own.length !== bus.connections.length) return null
    if (getSkew(own) <= bus.maxLengthSkew! + EPSILON) continue
    const minimum = Math.min(...own.map((plan) => plan.length))
    const overlong = own
      .filter((plan) => plan.length > minimum + bus.maxLengthSkew! + EPSILON)
      .toSorted(
        (a, b) => b.length - a.length || a.connectionIndex - b.connectionIndex,
      )
      .slice(0, 2)
    if (overlong.length !== 2) return null
    const targetLayer = own[0]!.targetLayer
    if (
      !bus.exitEdge ||
      own.some(
        (p) =>
          p.targetLayer !== targetLayer ||
          p.planeEndpointTrace ||
          p.planeEndpointSegments ||
          p.planeEndpointVia,
      )
    )
      return null
    const permitted = (
      bus.routableEscapeLayers ??
      bus.allowedLayers ??
      layerNames
    ).filter((layer) => (bus.allowedLayers ?? layerNames).includes(layer))
    const transitLayers = permitted.filter((layer) => layer !== targetLayer)
    if (!permitted.includes(targetLayer) || !transitLayers.length) return null
    const indices = new Set(overlong.map((plan) => plan.connectionIndex))
    const connections = bus.connections.filter((c) =>
      indices.has(c.connectionIndex),
    )
    const steps = routeReservedViaBusesSteps({
      ...params,
      srj: inputSrj,
      allBuses: preparedBuses,
      buses: [{ ...bus, connections }],
      targetLayer,
      transitLayers,
      terminals: connections.map((connection) => ({
        connection,
        viaPoint: sources.fixed.get(connection.connectionIndex)!,
        exitPoint: own.find(
          (p) => p.connectionIndex === connection.connectionIndex,
        )!.exitPoint,
      })),
      fixedViaPointsByConnectionIndex: sources.fixed,
      sourceEscapePaths: sources.sourcePaths,
      acceptedPlans: plans.filter((plan) => !indices.has(plan.connectionIndex)),
      tightViaChannels: true,
      includeDiagonalNeighbors: true,
      ripCost: 64,
      shuffleSeed: 1,
      maximumIterations,
      maximumRipEvents: 80,
      maximumLocalRepairAttempts: 0,
    })
    let next = steps.next()
    while (!next.done) {
      yield { ...next.value, busId: bus.busId, phase: "overlong-pair" }
      next = steps.next()
    }
    if (!next.value || next.value.length !== 2) return null
    const routed = new Map(
      next.value.map((plan) => [plan.connectionIndex, plan]),
    )
    const candidate = plans.map((original) => {
      const replacement = routed.get(original.connectionIndex)
      return replacement ? retainSource(original, replacement) : original
    })
    if (candidate.some((plan) => !plan)) return null
    const matched = matchBusPlanLengths({
      ...params,
      plans: candidate as FanoutRoutePlan[],
      preparedBuses: [bus],
      sharedBoundary: bus.sharedBoundary,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
      allowMatchingInsideDenseBounds: true,
      allowPairLaneSpreading: true,
      allowUnconstrainedLaneRerouting: true,
      maximumWorkUnits: 1_000,
    })
    if (!matched.plans) return null
    const tuned = new Map(
      matched.plans.map((plan) => [plan.connectionIndex, plan]),
    )
    const restored = plans.map((original) =>
      original.busId === bus.busId
        ? retainSource(original, tuned.get(original.connectionIndex)!)
        : original,
    )
    if (restored.some((plan) => !plan)) return null
    const complete = restored as FanoutRoutePlan[]
    if (
      getSkew(complete.filter((plan) => plan.busId === bus.busId)) >
        bus.maxLengthSkew! + EPSILON ||
      !fanoutPlansAreClear({
        plans: complete,
        srj: inputSrj,
        sharedBoundary: bus.sharedBoundary,
        clearance: params.clearance,
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: false,
      })
    )
      return null
    plans = complete
    repairedAny = true
  }
  if (
    !repairedAny ||
    preparedBuses.some(
      (bus) =>
        (!params.busIds || params.busIds.includes(bus.busId)) &&
        bus.maxLengthSkew !== undefined &&
        getSkew(plans.filter((plan) => plan.busId === bus.busId)) >
          bus.maxLengthSkew + EPSILON,
    )
  )
    return null
  const validation = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: {
      ...inputSrj,
      traces: [
        ...(inputSrj.traces ?? []),
        ...plans.flatMap((plan) => [
          plan.trace,
          ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance: params.clearance,
    allowBlindAndBuriedVias: false,
  })
  return validation.valid ? plans : null
}

/** Preserve every successful existing repair before trying two blocked lanes. */
export function* rerouteBusWithRetainedBoundaryTailsSteps(
  params: RetainedBoundaryTailRepairParams,
): Generator<RetainedBoundaryTailRepairProgress, FanoutRoutePlan[] | null> {
  const existing = yield* rerouteExistingAndShortenedBoundaryTailsSteps(params)
  if (existing) return existing
  return yield* rerouteTwoOverlongLanesSteps(params)
}
