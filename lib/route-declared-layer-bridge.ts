import { getCornerBandSide } from "./boundary-exit"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import { fanoutPlansAreClear, type RouteBusParams } from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import {
  buildViaMinimalWindingPlan,
  type RouteViaMinimalWindingProgress,
  routeViaMinimalWindingAlternativesSteps,
  type ViaMinimalWindingReservedVia,
  type ViaMinimalWindingTerminal,
} from "./route-via-minimal-winding"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  RoutedSegment,
  RoutedVia,
} from "./types"

export type BridgeBlockedOrderPolicy = "prioritize-blocked" | "append-blocked"

export interface DeclaredLayerBridgeParams extends RouteBusParams {
  /** Determines when route orders suggested by a blocked terminal are tried. */
  blockedOrderPolicy?: BridgeBlockedOrderPolicy
  /** Caller-chosen original ordered exits, already inside the declared edge/half. */
  terminals: readonly ViaMinimalWindingTerminal[]
  sourceEscapes: readonly PeripheralSourceEscape[]
  /** Prepared source-only plans for every source, including pending buses. */
  sourcePlans: readonly FanoutRoutePlan[]
  sourceBoundary: Bounds
  maximumSearches?: number
  maximumDirectOrders?: number
  maximumBridgePairs?: number
  maximumSourceSites?: number
  /** Leave a longer target-layer tail for subsequent bus length matching. */
  minimumPrimaryReturnSteps?: number
  maximumPartialCandidates?: number
  /** Prioritize one nearby lane substitution within the same partial budget. */
  preferAlternateBlockedLane?: boolean
  onDirectCandidate?: (
    plans: readonly FanoutRoutePlan[],
    blocked: ViaMinimalWindingTerminal,
  ) => void
  onPartialCandidate?: (
    plans: readonly FanoutRoutePlan[],
    blocked: ViaMinimalWindingTerminal,
  ) => void
  onSearchPhase?: (phase: string, searches: number, completed: number) => void
}

export interface DeclaredLayerBridgeResult {
  plans: FanoutRoutePlan[]
  requiresLengthMatching: boolean
  searchCount: number
}

/** Complete a bus using a local bridge or at most two declared primary landings.
 * All source copper and through-via geometry are immutable. A primary landing may
 * change to an allowed non-source crossover layer; every final exit remains on
 * targetLayer. The caller must run its normal complete-layout length matcher.
 */
export function* routeDeclaredLayerBridgeSteps(
  params: DeclaredLayerBridgeParams,
): Generator<
  RouteViaMinimalWindingProgress,
  DeclaredLayerBridgeResult | null,
  void
> {
  const { bus, targetLayer, traceWidth: width, clearance } = params
  const blockedOrderPolicy = params.blockedOrderPolicy ?? "prioritize-blocked"
  if (
    blockedOrderPolicy !== "prioritize-blocked" &&
    blockedOrderPolicy !== "append-blocked"
  )
    throw new Error("Unsupported blocked-terminal route-order policy")
  const prioritizeBlocked = blockedOrderPolicy === "prioritize-blocked"
  const originals = new Map(
    bus.connections.map((connection) => [
      connection.connectionIndex,
      connection,
    ]),
  )
  const terminals = params.terminals.map((terminal) => {
    const connection = originals.get(terminal.connection.connectionIndex)
    if (!connection)
      throw new Error("Bridge terminal does not belong to the original bus")
    return { ...terminal, connection }
  })
  for (const [value, maximum] of [
    [params.maximumSearches, 2048],
    [params.maximumDirectOrders, 48],
    [params.maximumBridgePairs, 256],
    [params.maximumSourceSites, 256],
    [params.maximumPartialCandidates, 3],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 0 || value > maximum)
    )
      throw new Error(
        "Bridge search limit is outside the supported finite range",
      )
  }
  if (
    params.minimumPrimaryReturnSteps !== undefined &&
    (!Number.isInteger(params.minimumPrimaryReturnSteps) ||
      params.minimumPrimaryReturnSteps < 1 ||
      params.minimumPrimaryReturnSteps > 7)
  )
    throw new Error("Primary return steps must be between one and seven")
  const allowed = bus.routableEscapeLayers ?? bus.allowedLayers ?? []
  const crossovers = allowed.filter((layer) => layer !== targetLayer)
  if (
    params.allowBlindAndBuriedVias ||
    bus.termination.type !== "boundary" ||
    !bus.exitEdge ||
    !allowed.includes(targetLayer) ||
    !crossovers.length ||
    terminals.length !== bus.connections.length ||
    terminals.length < 1 ||
    terminals.length > 16
  )
    return null
  const own = new Set(
    bus.connections.map((connection) => connection.connectionIndex),
  )
  if (
    new Set(terminals.map((terminal) => terminal.connection.connectionIndex))
      .size !== own.size ||
    terminals.some((terminal) => !own.has(terminal.connection.connectionIndex))
  )
    throw new Error(
      "Bridge terminals must contain every original bus connection exactly once",
    )
  const horizontal = bus.exitEdge === "left" || bus.exitEdge === "right"
  const axis = horizontal ? "y" : "x"
  const normalAxis = horizontal ? "x" : "y"
  const normalSign =
    bus.exitEdge === "left" || bus.exitEdge === "bottom" ? 1 : -1
  const boundary = bus.sharedBoundary
  const normalEdge =
    bus.exitEdge === "left"
      ? boundary.minX
      : bus.exitEdge === "right"
        ? boundary.maxX
        : bus.exitEdge === "bottom"
          ? boundary.minY
          : boundary.maxY
  const midpoint = horizontal
    ? (boundary.minY + boundary.maxY) / 2
    : (boundary.minX + boundary.maxX) / 2
  const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
  if (
    terminals.some(
      ({ exitPoint }) =>
        Math.abs(exitPoint[normalAxis] - normalEdge) > 1e-7 ||
        exitPoint.x < boundary.minX ||
        exitPoint.x > boundary.maxX ||
        exitPoint.y < boundary.minY ||
        exitPoint.y > boundary.maxY ||
        (side === "minimum" && exitPoint[axis] >= midpoint) ||
        (side === "maximum" && exitPoint[axis] <= midpoint),
    )
  )
    return null
  const sources = new Map(
    params.sourceEscapes.map((source) => [source.connectionIndex, source]),
  )
  const sourcePlans = new Map(
    params.sourcePlans.map((plan) => [plan.connectionIndex, plan]),
  )
  for (const source of params.sourceEscapes) {
    const plan = sourcePlans.get(source.connectionIndex)
    if (
      !plan?.via ||
      distance(plan.via.center, source.via.center) > 1e-7 ||
      plan.via.diameter !== source.via.diameter ||
      plan.via.holeDiameter !== source.via.holeDiameter ||
      plan.via.spanLayers.length !== source.via.spanLayers.length ||
      source.via.spanLayers.some(
        (layer) => !plan.via!.spanLayers.includes(layer),
      ) ||
      plan.segments.length !== source.segments.length ||
      plan.segments.some((segment, index) => {
        const expected = source.segments[index]!
        return (
          segment.layer !== expected.layer ||
          segment.width !== expected.width ||
          distance(segment.start, expected.start) > 1e-7 ||
          distance(segment.end, expected.end) > 1e-7
        )
      })
    )
      throw new Error(
        "Bridge source plans must preserve every original source escape",
      )
  }
  for (const terminal of terminals) {
    const source = sources.get(terminal.connection.connectionIndex)
    if (
      !source ||
      !sourcePlans.has(terminal.connection.connectionIndex) ||
      !source.segments.length ||
      params.layerNames.some(
        (layer) => !source.via.spanLayers.includes(layer),
      ) ||
      distance(source.via.center, terminal.viaPoint) > 1e-7
    )
      throw new Error("Missing or changed original bridge source")
  }
  const fixed = new Map(
    params.sourcePlans
      .filter((plan) => !own.has(plan.connectionIndex))
      .map((plan) => [plan.connectionIndex, plan]),
  )
  for (const plan of params.acceptedPlans) {
    if (own.has(plan.connectionIndex))
      throw new Error("Bridge bus must be uncommitted")
    fixed.set(plan.connectionIndex, plan)
  }
  const accepted = [...fixed.values()]
  const ownStubs = terminals.map(
    (terminal) => sourcePlans.get(terminal.connection.connectionIndex)!,
  )
  const reserved: ViaMinimalWindingReservedVia[] = [
    ...(params.reservedVias ?? []),
    ...params.sourceEscapes.map((source) => ({
      connectionName: source.connectionName,
      via: source.via,
    })),
    // A diameter equal to width reproduces reserveTerminalExitPoints' exact pitch.
    ...terminals.map((terminal) => ({
      connectionName: terminal.connection.connection.name,
      via: {
        center: terminal.exitPoint,
        diameter: width,
        spanLayers: [targetLayer],
      },
    })),
  ]
  let searchCount = 0
  const maximumSearches = params.maximumSearches ?? 768
  const combine = (plans: readonly FanoutRoutePlan[]) => {
    const byIndex = new Map(
      ownStubs.map((plan) => [plan.connectionIndex, plan]),
    )
    for (const plan of plans) byIndex.set(plan.connectionIndex, plan)
    return [...accepted, ...byIndex.values()]
  }
  function* path(
    terminal: ViaMinimalWindingTerminal,
    layer: string,
    plans: readonly FanoutRoutePlan[],
    laneBias: -1 | 0 | 1 = 0,
    from = terminal.viaPoint,
    to = terminal.exitPoint,
    additional: readonly RoutedVia[] = [],
  ): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan | null, void> {
    if (searchCount >= maximumSearches) return null
    searchCount++
    const connection = {
      ...terminal.connection,
      sourcePoint: { ...from, layer },
      sourceLayer: layer,
    }
    const routes = yield* routeViaMinimalWindingAlternativesSteps(
      {
        ...params,
        bus: { ...bus, connections: [connection] },
        acceptedPlans: combine(plans),
        targetLayer: layer,
        terminals: [{ connection, viaPoint: from, exitPoint: to }],
        reservedVias: [
          ...reserved,
          ...additional.map((via) => ({
            connectionName: connection.connection.name,
            via,
          })),
        ],
        sourceEscapePaths: new Map([
          [connection.connectionIndex, [from, from]],
        ]),
        allowSourceLayerRouting: true,
        viaDiameter: 0,
        viaHoleDiameter: 0,
        gridStep: width,
        alignGridToPads: true,
        maximumRouteOrderAttempts: 1,
        routeOrder: [0],
        laneBias,
        reserveTerminalExitPoints: false,
      },
      1,
      false,
    )
    return routes[0]?.[0] ?? null
  }
  const via = (
    center: Point2D,
    fromLayer: string,
    toLayer: string,
  ): RoutedVia => ({
    center,
    diameter: params.viaDiameter,
    holeDiameter: params.viaHoleDiameter,
    spanLayers: [...params.layerNames],
    fromLayer,
    toLayer,
  })
  const build = (
    terminal: ViaMinimalWindingTerminal,
    targetSegments: readonly RoutedSegment[],
    additionalVias: RoutedVia[] = [],
    landing = targetLayer,
  ) => {
    const source = sources.get(terminal.connection.connectionIndex)!
    const sourcePoints = [
      source.segments[0]!.start,
      ...source.segments.map((segment) => segment.end),
    ]
    const plan = buildViaMinimalWindingPlan({
      ...params,
      terminal,
      sourceEscapePoints: sourcePoints,
      allowBlindAndBuriedVias: false,
      targetLayerPoints: [terminal.viaPoint, terminal.exitPoint],
    })
    plan.via = { ...source.via, toLayer: landing }
    plan.additionalVias = additionalVias
    plan.segments = [...source.segments, ...targetSegments]
    plan.sourceEscapeSegmentCount = source.segments.length
    plan.length = plan.segments.reduce(
      (sum, segment) => sum + distance(segment.start, segment.end),
      0,
    )
    const allVias = [plan.via, ...additionalVias]
    const route: FanoutRoutePlan["trace"]["route"] = []
    for (const [index, segment] of plan.segments.entries()) {
      route.push(
        {
          route_type: "wire",
          ...segment.start,
          width: segment.width,
          layer: segment.layer,
        },
        {
          route_type: "wire",
          ...segment.end,
          width: segment.width,
          layer: segment.layer,
        },
      )
      const next = plan.segments[index + 1]
      if (next && next.layer !== segment.layer) {
        const transition = allVias.find(
          (candidate) =>
            distance(candidate.center, segment.end) < 1e-7 &&
            candidate.fromLayer === segment.layer &&
            candidate.toLayer === next.layer,
        )
        if (!transition)
          throw new Error("Bridge path omitted a required layer transition")
        route.push({
          route_type: "via",
          ...transition.center,
          from_layer: transition.fromLayer,
          to_layer: transition.toLayer,
          via_diameter: transition.diameter,
          via_hole_diameter: transition.holeDiameter,
        })
      }
    }
    plan.trace = { ...plan.trace, route }
    return plan
  }
  const noSelfContacts = (plan: FanoutRoutePlan) => {
    for (let i = 0; i < plan.segments.length; i++)
      for (let j = i + 2; j < plan.segments.length; j++) {
        const first = plan.segments[i]!
        const second = plan.segments[j]!
        if (
          first.layer === second.layer &&
          distanceSegmentToSegment(
            first.start,
            first.end,
            second.start,
            second.end,
          ) < 1e-7
        )
          return false
      }
    return true
  }
  const finish = (
    plans: FanoutRoutePlan[],
    allowPartial = false,
  ): DeclaredLayerBridgeResult | null => {
    if (
      (!allowPartial && plans.length !== terminals.length) ||
      plans.some((plan) => !noSelfContacts(plan)) ||
      !fanoutPlansAreClear({
        ...params,
        plans: combine(plans),
        sharedBoundary: boundary,
      })
    )
      return null
    const spread =
      Math.max(...plans.map((plan) => plan.length)) -
      Math.min(...plans.map((plan) => plan.length))
    return {
      plans,
      requiresLengthMatching:
        bus.maxLengthSkew !== undefined && spread > bus.maxLengthSkew + 1e-6,
      searchCount,
    }
  }
  const ordered = [...terminals].sort(
    (a, b) => a.exitPoint[axis] - b.exitPoint[axis],
  )
  const orders = [
    ordered,
    [...ordered.slice(1), ordered[0]!],
    ordered.toReversed(),
    ...(["x", "y"] as const).flatMap((axis) => {
      const sorted = terminals.toSorted(
        (a, b) => a.viaPoint[axis] - b.viaPoint[axis],
      )
      return [sorted, sorted.toReversed()]
    }),
  ]
  const pendingOrders: ViaMinimalWindingTerminal[][] = []
  const orderKeys = new Set(
    orders.map((order) =>
      order.map((t) => t.connection.connectionIndex).join(","),
    ),
  )
  const enqueueOrder = (order: ViaMinimalWindingTerminal[]) => {
    const key = order.map((t) => t.connection.connectionIndex).join(",")
    // Preserve each policy's existing accounting of initial duplicate orders.
    const count = prioritizeBlocked ? orderKeys.size : orders.length
    if (!orderKeys.has(key) && count < 48) {
      orderKeys.add(key)
      if (prioritizeBlocked) pendingOrders.push(order)
      else orders.push(order)
    }
  }
  const maximumPartials = params.maximumPartialCandidates ?? 3
  const partials: {
    plans: FanoutRoutePlan[]
    blocked: ViaMinimalWindingTerminal
  }[] = []
  const doublePartials: FanoutRoutePlan[][] = []
  const partialKeys = new Set<string>()
  let orderCount = 0
  function* nextOrder() {
    if (prioritizeBlocked) {
      while (pendingOrders.length || orders.length)
        yield pendingOrders.shift() ?? orders.shift()!
    } else {
      // Do not consume the array: appended-order limits count all prior orders.
      for (const order of orders) yield order
    }
  }
  direct: for (const order of nextOrder())
    for (const laneBias of [0, -1, 1] as const) {
      if (
        orderCount++ >=
        (params.maximumDirectOrders ?? (prioritizeBlocked ? 6 : 48))
      )
        break direct
      const plans: FanoutRoutePlan[] = []
      for (const terminal of order) {
        const result = yield* path(terminal, targetLayer, plans, laneBias)
        if (!result) {
          params.onDirectCandidate?.(plans, terminal)
          params.onSearchPhase?.(
            `direct-blocked-${terminal.connection.connectionIndex}`,
            searchCount,
            plans.length,
          )
          if (plans.length >= terminals.length - 2) {
            const key = JSON.stringify(
              plans
                .toSorted((a, b) => a.connectionIndex - b.connectionIndex)
                .map((plan) => [plan.connectionIndex, plan.segments]),
            )
            if (!partialKeys.has(key)) {
              partialKeys.add(key)
              if (plans.length === terminals.length - 1) {
                if (
                  !params.preferAlternateBlockedLane ||
                  partials.length < maximumPartials
                )
                  partials.push({ plans, blocked: terminal })
              } else if (
                doublePartials.length <
                  (params.maximumPartialCandidates ?? 3) &&
                !doublePartials.some((prior) =>
                  terminals
                    .filter(
                      (t) =>
                        !plans.some(
                          (p) =>
                            p.connectionIndex === t.connection.connectionIndex,
                        ),
                    )
                    .every(
                      (t) =>
                        !prior.some(
                          (p) =>
                            p.connectionIndex === t.connection.connectionIndex,
                        ),
                    ),
                )
              )
                doublePartials.push(plans)
            }
          }
          const others = order.filter((t) => t !== terminal)
          enqueueOrder([terminal, ...others])
          enqueueOrder([...others, terminal])
          continue
        }
        plans.push(build(terminal, result.segments))
      }
      if (
        plans.length >= terminals.length - 2 &&
        plans.length < terminals.length
      ) {
        const missing = terminals.filter(
          (terminal) =>
            !plans.some(
              (plan) =>
                plan.connectionIndex === terminal.connection.connectionIndex,
            ),
        )
        params.onPartialCandidate?.(plans, missing[0]!)
        const key = JSON.stringify(
          plans
            .toSorted((a, b) => a.connectionIndex - b.connectionIndex)
            .map((plan) => [plan.connectionIndex, plan.segments]),
        )
        if (!partialKeys.has(key)) {
          partialKeys.add(key)
          if (missing.length === 1) {
            if (
              !params.preferAlternateBlockedLane ||
              partials.length < maximumPartials
            )
              partials.push({ plans, blocked: missing[0]! })
          } else if (
            doublePartials.length < (params.maximumPartialCandidates ?? 3) &&
            !doublePartials.some((prior) =>
              missing.every(
                (t) =>
                  !prior.some(
                    (p) => p.connectionIndex === t.connection.connectionIndex,
                  ),
              ),
            )
          )
            doublePartials.push(plans)
        }
      }
      if (plans.length === terminals.length) {
        const result = finish(plans)
        if (result) return result
      }
    }
  const anchor = partials[0]
  if (
    anchor &&
    maximumPartials > 0 &&
    (params.preferAlternateBlockedLane || partials.length < maximumPartials)
  ) {
    const nearby = anchor.plans
      .toSorted((a, b) => {
        const nearest = (plan: FanoutRoutePlan) =>
          Math.min(
            ...plan.segments
              .filter((segment) => segment.layer === targetLayer)
              .map((segment) =>
                distancePointToSegment(
                  anchor.blocked.viaPoint,
                  segment.start,
                  segment.end,
                ),
              ),
          )
        return nearest(a) - nearest(b)
      })
      .slice(0, 8)
    for (const deferred of nearby) {
      const retained = anchor.plans.filter((plan) => plan !== deferred)
      const direct = yield* path(anchor.blocked, targetLayer, retained)
      if (!direct) continue
      const plans = [...retained, build(anchor.blocked, direct.segments)]
      if (
        !fanoutPlansAreClear({
          ...params,
          plans: combine(plans),
          sharedBoundary: boundary,
        })
      )
        continue
      const blocked = terminals.find(
        (terminal) =>
          terminal.connection.connectionIndex === deferred.connectionIndex,
      )!
      if (params.preferAlternateBlockedLane) {
        // Preserve a bounded portfolio while trying a different blocked lane
        // before geometrically different routes for the same blocked lane.
        partials.length = Math.min(partials.length, maximumPartials - 1)
        partials.unshift({ plans, blocked })
        break
      }
      partials.push({ plans, blocked })
      if (partials.length >= maximumPartials) break
    }
  }
  for (const candidate of partials.slice(
    0,
    params.maximumPartialCandidates ?? 3,
  )) {
    const result = yield* completePartial(candidate.plans, candidate.blocked)
    if (result) return result
    if (searchCount >= maximumSearches) break
  }
  // A second primary landing is bounded to two missing lanes and two orders.
  // All existing source copper and primary geometry stay fixed between them.
  if (
    crossovers.some((layer) =>
      terminals.every((t) => t.connection.sourceLayer !== layer),
    )
  ) {
    for (const initial of doublePartials) {
      const missing = terminals.filter(
        (terminal) =>
          !initial.some(
            (plan) =>
              plan.connectionIndex === terminal.connection.connectionIndex,
          ),
      )
      if (missing.length !== 2) continue
      for (const order of [missing, missing.toReversed()]) {
        let plans = initial
        for (const remaining of order) {
          const result = yield* completePartial(plans, remaining, true, true)
          if (!result) break
          plans = result.plans
        }
        const result = finish(plans)
        if (result) return result
        if (searchCount >= maximumSearches) return null
      }
    }
  }
  return null
  function* completePartial(
    best: FanoutRoutePlan[],
    remaining: ViaMinimalWindingTerminal,
    allowPartial = false,
    primaryOnly = false,
  ): Generator<
    RouteViaMinimalWindingProgress,
    DeclaredLayerBridgeResult | null,
    void
  > {
    params.onPartialCandidate?.(best, remaining)
    params.onSearchPhase?.("bridge", searchCount, best.length)
    const fixedPlans = combine(best)
    const clearSite = (point: Point2D) => {
      const margin = params.viaDiameter / 2 + clearance
      if (
        point.x < boundary.minX + margin ||
        point.x > boundary.maxX - margin ||
        point.y < boundary.minY + margin ||
        point.y > boundary.maxY - margin
      )
        return false
      if (
        params.srj.obstacles.some(
          (obstacle) =>
            distancePointToObstacle(point, obstacle) < margin - 1e-7,
        )
      )
        return false
      if (
        params.sourceEscapes.some(
          (source) =>
            distance(point, source.via.center) <
            (params.viaDiameter + source.via.diameter) / 2 + clearance - 1e-7,
        )
      )
        return false
      return fixedPlans
        .filter(
          (plan) =>
            plan.connectionIndex !== remaining.connection.connectionIndex,
        )
        .every(
          (plan) =>
            [plan.via, ...(plan.additionalVias ?? [])].every(
              (other) =>
                !other ||
                distance(point, other.center) >=
                  (params.viaDiameter + other.diameter) / 2 + clearance - 1e-7,
            ) &&
            plan.segments.every(
              (segment) =>
                distancePointToSegment(point, segment.start, segment.end) >=
                params.viaDiameter / 2 + segment.width / 2 + clearance - 1e-7,
            ),
        )
    }
    const pitch = width + clearance
    const portPitch =
      Math.ceil((params.viaDiameter + clearance) / pitch) * pitch
    // First use a physically existing primary through-via to enter a permitted inner layer.
    for (const crossover of crossovers.filter(
      (layer) => layer !== remaining.connection.sourceLayer,
    )) {
      const tangentSigns =
        side === "minimum" ? [-1] : side === "maximum" ? [1] : [1, -1]
      for (let along = 0; along <= 7; along++)
        for (const sign of tangentSigns)
          for (
            let inward = params.minimumPrimaryReturnSteps ?? 1;
            inward <= 7;
            inward++
          ) {
            const point = {
              ...remaining.exitPoint,
              [normalAxis]:
                remaining.exitPoint[normalAxis] +
                normalSign * inward * portPitch,
              [axis]: remaining.exitPoint[axis] + sign * along * portPitch,
            }
            if (!clearSite(point)) continue
            const addition = via(point, crossover, targetLayer)
            const tail = yield* path(
              remaining,
              targetLayer,
              best,
              0,
              point,
              remaining.exitPoint,
              [addition],
            )
            if (!tail) continue
            const middle = yield* path(
              remaining,
              crossover,
              best,
              0,
              remaining.viaPoint,
              point,
              [addition],
            )
            if (!middle) continue
            const result = finish(
              [
                ...best,
                build(
                  remaining,
                  [...middle.segments, ...tail.segments],
                  [addition],
                  crossover,
                ),
              ],
              allowPartial,
            )
            if (result) return result
          }
    }
    if (primaryOnly) return null
    const coordinateSites = (axis: "x" | "y", pitch: number) => {
      const values = [
        ...new Set(
          bus.componentObstacles.map((obstacle) => obstacle.center[axis]),
        ),
      ].sort((a, b) => a - b)
      if (values.length < 2)
        return Array.from(
          { length: 9 },
          (_, i) => remaining.viaPoint[axis] + (i - 4) * pitch,
        )
      const sites = values.slice(1).map((value, i) => (values[i]! + value) / 2)
      sites.unshift(values[0]! - (values[1]! - values[0]!) / 2)
      sites.push(values.at(-1)! + (values.at(-1)! - values.at(-2)!) / 2)
      return sites
        .toSorted(
          (a, b) =>
            Math.abs(a - remaining.viaPoint[axis]) -
            Math.abs(b - remaining.viaPoint[axis]),
        )
        .slice(0, 33)
    }
    const sites = coordinateSites("x", bus.pitchX)
      .flatMap((x) => coordinateSites("y", bus.pitchY).map((y) => ({ x, y })))
      .filter(
        (point) =>
          point.x >= params.sourceBoundary.minX &&
          point.x <= params.sourceBoundary.maxX &&
          point.y >= params.sourceBoundary.minY &&
          point.y <= params.sourceBoundary.maxY &&
          clearSite(point),
      )
    const candidates = sites
      .toSorted(
        (a, b) =>
          distance(a, remaining.viaPoint) - distance(b, remaining.viaPoint),
      )
      .slice(0, params.maximumSourceSites ?? 128)
    const fromSource: { point: Point2D; path: FanoutRoutePlan }[] = []
    for (const point of candidates) {
      const prefix = yield* path(
        remaining,
        targetLayer,
        best,
        0,
        remaining.viaPoint,
        point,
      )
      if (prefix) fromSource.push({ point, path: prefix })
      if (searchCount >= maximumSearches) return null
    }
    params.onSearchPhase?.("source-components", searchCount, fromSource.length)
    const sourceKeys = new Set(
      fromSource.map(({ point }) => `${point.x},${point.y}`),
    )
    const pairs = fromSource
      .flatMap((first) =>
        sites
          .filter((point) => !sourceKeys.has(`${point.x},${point.y}`))
          .map((point) => ({
            first,
            point,
            distance: distance(first.point, point),
          })),
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, params.maximumBridgePairs ?? 80)
    const tails = new Map<string, FanoutRoutePlan | null>()
    for (const { first, point } of pairs) {
      const key = `${point.x},${point.y}`
      if (!tails.has(key))
        tails.set(
          key,
          yield* path(
            remaining,
            targetLayer,
            best,
            0,
            point,
            remaining.exitPoint,
          ),
        )
      const tail = tails.get(key)
      if (!tail) continue
      for (const crossover of crossovers) {
        const firstVia = via(first.point, targetLayer, crossover)
        const secondVia = via(point, crossover, targetLayer)
        const bridge = yield* path(
          remaining,
          crossover,
          best,
          0,
          first.point,
          point,
          [firstVia, secondVia],
        )
        if (!bridge) continue
        const result = finish([
          ...best,
          build(
            remaining,
            [...first.path.segments, ...bridge.segments, ...tail.segments],
            [firstVia, secondVia],
          ),
        ])
        if (result) return result
      }
    }
    return null
  }
}

/** Short search prioritizes newly blocked terminals before remaining base orders. */
export function routeShortDeclaredLayerBridgeSteps(
  params: Omit<DeclaredLayerBridgeParams, "blockedOrderPolicy">,
): ReturnType<typeof routeDeclaredLayerBridgeSteps> {
  return routeDeclaredLayerBridgeSteps({
    ...params,
    blockedOrderPolicy: "prioritize-blocked",
  })
}

/** Extended search keeps base orders first and appends blocked-terminal retries. */
export function routeExtendedDeclaredLayerBridgeSteps(
  params: Omit<DeclaredLayerBridgeParams, "blockedOrderPolicy">,
): ReturnType<typeof routeDeclaredLayerBridgeSteps> {
  return routeDeclaredLayerBridgeSteps({
    ...params,
    blockedOrderPolicy: "append-blocked",
  })
}
