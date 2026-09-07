import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
} from "./geometry"
import {
  type DogboneViaSiteGeometryRules,
  getComponentDogboneViaSiteCandidates,
} from "./match-component-dogbone-via-sites"
import {
  matchSourceViaSites,
  type SourceViaSiteFailure,
} from "./match-source-via-sites"
import { fanoutPlansAreClear } from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import {
  buildViaMinimalWindingPlan,
  type RouteViaMinimalWindingParams,
  type RouteViaMinimalWindingProgress,
  routeViaMinimalWindingAlternativesSteps,
  type ViaMinimalWindingTerminal,
} from "./route-via-minimal-winding"
import type { FanoutRoutePlan, Point2D, PreparedBus, RoutedVia } from "./types"

export interface RouteBusWithNativePlaneRecoveryParams
  extends RouteViaMinimalWindingParams {
  preparedBuses: readonly PreparedBus[]
  sourceEscapes: readonly PeripheralSourceEscape[]
  /** Already validated leading routes in the supplied terminal order. */
  initialPlans?: readonly FanoutRoutePlan[]
  /** Diagnostic feedback only. The caller must not mutate supplied geometry. */
  onFailure?: (failure: NativePlaneRecoveryFailure) => void
  /** Expose the first checked frontier without launching grouped recovery. */
  stopAtFirstBlockedTerminal?: boolean
  maximumFeedbackRounds?: number
  maximumPlaneCandidates?: number
  maximumNativeSearchStates?: number
}
export interface NativePlaneRecoveryFailure {
  kind:
    | "no-blocker"
    | "routing"
    | "plane-matching"
    | "source-extension"
    | "feedback-limit"
  blockedConnectionIndex: number
  blockerConnectionIndices: readonly number[]
  /** A leading prefix checked against every current source reservation. */
  prefixPlans: readonly FanoutRoutePlan[]
  planeFailure?: SourceViaSiteFailure
}
export interface NativePlaneRecoveryResult {
  /** Input accepted copper plus the complete bus and rebuilt plane endpoints. */
  plans: FanoutRoutePlan[]
  sourceEscapes: PeripheralSourceEscape[]
}
const EPS = 1e-9
function vias(plan: FanoutRoutePlan): RoutedVia[] {
  return [
    plan.via,
    ...(plan.additionalVias ?? []),
    plan.planeEndpointVia,
  ].filter((via): via is RoutedVia => !!via)
}
/** Recover an ordered bus by rerouting exact blockers together with its unfinished
 * suffix. Plane sites remain provisional until exact native matching and full
 * copper checks pass. Conservative CSP hints only add existing reservations.
 * The caller remains responsible for whole-bus timing and final validation. */
export function* routeBusWithNativePlaneRecoverySteps(
  params: RouteBusWithNativePlaneRecoveryParams,
): Generator<
  RouteViaMinimalWindingProgress,
  NativePlaneRecoveryResult | null,
  void
> {
  const feedbackLimit = params.maximumFeedbackRounds ?? 12
  const planeLimit = params.maximumPlaneCandidates ?? 96
  const nativeLimit = params.maximumNativeSearchStates ?? 300000
  if (
    [feedbackLimit, planeLimit, nativeLimit].some(
      (n) => !Number.isInteger(n) || n < 1,
    )
  )
    throw Error("Native plane recovery requires positive finite search limits")
  if (
    params.allowSameNetMerges ||
    params.bus.termination.type !== "boundary" ||
    !params.bus.exitEdge
  )
    return null
  if (
    params.terminals.length !== params.bus.connections.length ||
    params.bus.connections.some(
      (c) =>
        !params.terminals.some(
          (t) => t.connection.connectionIndex === c.connectionIndex,
        ),
    )
  )
    throw Error("Native plane recovery requires the complete bus")
  const holders = new Map(
    params.preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const sources = new Map(
    params.sourceEscapes.map((source) => [source.connectionIndex, source]),
  )
  if (sources.size !== params.sourceEscapes.length)
    throw Error("Native plane recovery requires unique source identities")
  const own = new Set(params.terminals.map((t) => t.connection.connectionIndex))
  const accepted = params.acceptedPlans.filter(
    (p) => !own.has(p.connectionIndex),
  )
  const acceptedIds = new Set(accepted.map((p) => p.connectionIndex))
  if (
    acceptedIds.size !== accepted.length ||
    own.size !== params.terminals.length
  )
    throw Error("Native plane recovery requires unique route identities")
  const sourcePlan = (
    sourceEscape: PeripheralSourceEscape,
  ): FanoutRoutePlan => {
    const holder = holders.get(sourceEscape.connectionIndex)
    if (!holder || !sourceEscape.segments.length)
      throw Error("Native plane recovery requires prepared source escapes")
    const plan = buildViaMinimalWindingPlan({
      ...params,
      bus: holder.bus,
      targetLayer: sourceEscape.via.toLayer,
      viaDiameter: sourceEscape.via.diameter,
      viaHoleDiameter: sourceEscape.via.holeDiameter,
      terminal: {
        connection: holder.connection,
        viaPoint: sourceEscape.via.center,
        exitPoint: sourceEscape.via.center,
      },
      sourceEscapePoints: [
        sourceEscape.segments[0]!.start,
        ...sourceEscape.segments.map((s) => s.end),
      ],
      targetLayerPoints: [sourceEscape.via.center, sourceEscape.via.center],
      allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
    })
    const endpoint = accepted.find(
      (p) => p.connectionIndex === sourceEscape.connectionIndex,
    )
    return {
      ...plan,
      via: sourceEscape.via,
      termination: { type: "plane", layer: sourceEscape.via.toLayer },
      sourceEscapeSegmentCount: sourceEscape.segments.length,
      ...(endpoint?.planeEndpointTrace
        ? { planeEndpointTrace: endpoint.planeEndpointTrace }
        : {}),
      ...(endpoint?.planeEndpointSegments
        ? { planeEndpointSegments: endpoint.planeEndpointSegments }
        : {}),
      ...(endpoint?.planeEndpointVia
        ? { planeEndpointVia: endpoint.planeEndpointVia }
        : {}),
      length:
        plan.length +
        (endpoint?.planeEndpointSegments ?? []).reduce(
          (sum, s) => sum + distance(s.start, s.end),
          0,
        ),
    }
  }
  for (const sourceEscape of params.sourceEscapes)
    if (
      !own.has(sourceEscape.connectionIndex) &&
      !acceptedIds.has(sourceEscape.connectionIndex)
    ) {
      accepted.push(sourcePlan(sourceEscape))
      acceptedIds.add(sourceEscape.connectionIndex)
    }
  // Endpoint and bridge copper stays fixed while ordinary plane sources move.
  const planeBuses = params.preparedBuses
    .filter(
      (bus) =>
        bus.termination.type === "plane" &&
        bus.componentId === params.bus.componentId,
    )
    .map((bus) => ({
      ...bus,
      connections: bus.connections.filter((connection) => {
        const plan = accepted.find(
          (p) => p.connectionIndex === connection.connectionIndex,
        )
        return (
          !plan?.additionalVias?.length &&
          !plan?.planeEndpointSegments?.length &&
          !plan?.planeEndpointVia
        )
      }),
    }))
    .filter((bus) => bus.connections.length)
  const planeIds = new Set(
    planeBuses.flatMap((bus) => bus.connections.map((c) => c.connectionIndex)),
  )
  const allReserved = params.sourceEscapes.map((e) => ({
    connectionName: e.connectionName,
    via: e.via,
  }))
  const sourcePaths = new Map(
    params.sourceEscapes.map(
      (e) =>
        [
          e.connectionIndex,
          [e.segments[0]!.start, ...e.segments.map((s) => s.end)],
        ] as const,
    ),
  )
  const span = params.targetLayer
  const xs = params.terminals.map((t) => t.exitPoint.x)
  const ys = params.terminals.map((t) => t.exitPoint.y)
  const axis =
    Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)
      ? "x"
      : "y"
  const terminals = params.routeOrder
    ? params.routeOrder.map((index) => params.terminals[index]!)
    : params.terminals.toSorted((a, b) => a.exitPoint[axis] - b.exitPoint[axis])
  if (
    terminals.length !== params.terminals.length ||
    new Set(terminals).size !== terminals.length ||
    terminals.some((t) => !t)
  )
    throw Error("Native plane recovery requires a valid complete route order")
  for (const terminal of terminals) {
    const sourceEscape = sources.get(terminal.connection.connectionIndex)
    if (
      !sourceEscape ||
      distance(sourceEscape.via.center, terminal.viaPoint) > EPS
    )
      throw Error("Native plane recovery requires matching source vias")
  }
  const clear = (plans: FanoutRoutePlan[]) =>
    fanoutPlansAreClear({
      ...params,
      plans,
      sharedBoundary: params.bus.sharedBoundary,
    })
  if (
    !clear([
      ...accepted,
      ...params.sourceEscapes
        .filter((e) => own.has(e.connectionIndex))
        .map(sourcePlan),
    ])
  )
    return null
  const single = function* (
    terminal: ViaMinimalWindingTerminal,
    plans: FanoutRoutePlan[],
  ) {
    return yield* routeViaMinimalWindingAlternativesSteps(
      {
        ...params,
        bus: { ...params.bus, connections: [terminal.connection] },
        terminals: [terminal],
        acceptedPlans: plans,
        sourceEscapePaths: sourcePaths,
        reservedVias: [
          ...allReserved,
          ...terminals.map((t) => ({
            connectionName: t.connection.connection.name,
            via: {
              center: t.exitPoint,
              diameter: params.traceWidth,
              spanLayers: [span],
            },
          })),
        ],
        maximumRouteOrderAttempts: 1,
        routeOrder: [0],
        laneBias: params.laneBias ?? -1,
        adaptiveRouteOrder: false,
        reserveTerminalExitPoints: false,
      },
      1,
      false,
    )
  }
  const initial = new Map(
    (params.initialPlans ?? []).map((p) => [p.connectionIndex, p]),
  )
  if (
    initial.size !== (params.initialPlans?.length ?? 0) ||
    initial.size > terminals.length
  )
    throw Error("Native plane recovery requires a unique leading prefix")
  const prefix: FanoutRoutePlan[] = []
  for (const terminal of terminals.slice(0, initial.size)) {
    const connection = terminal.connection
    const plan = initial.get(connection.connectionIndex)
    const source = sources.get(connection.connectionIndex)!
    if (
      plan?.termination.type !== "boundary" ||
      plan.busId !== params.bus.busId ||
      plan.connectionName !== connection.connection.name ||
      plan.sourcePointIndex !== connection.sourcePointIndex ||
      plan.sourceObstacle !== connection.sourceObstacle ||
      plan.sourceLayer !== connection.sourceLayer ||
      plan.targetLayer !== params.targetLayer ||
      plan.exitEdge !== params.bus.exitEdge ||
      distance(plan.sourcePoint, connection.sourcePoint) > EPS ||
      distance(plan.targetPoint, connection.targetPoint) > EPS ||
      JSON.stringify(
        "layer" in plan.targetPoint
          ? plan.targetPoint.layer
          : plan.targetPoint.layers,
      ) !==
        JSON.stringify(
          "layer" in connection.targetPoint
            ? connection.targetPoint.layer
            : connection.targetPoint.layers,
        ) ||
      distance(plan.exitPoint, terminal.exitPoint) > EPS ||
      !plan.via ||
      distance(plan.via.center, source.via.center) > EPS ||
      Math.abs(plan.via.diameter - source.via.diameter) > EPS ||
      Math.abs(plan.via.holeDiameter - source.via.holeDiameter) > EPS ||
      plan.via.fromLayer !== source.via.fromLayer ||
      plan.via.spanLayers.length !== source.via.spanLayers.length ||
      source.via.spanLayers.some(
        (layer) => !plan.via!.spanLayers.includes(layer),
      ) ||
      (plan.sourceEscapeSegmentCount ?? 1) !== source.segments.length ||
      source.segments.some((segment, index) => {
        const actual = plan.segments[index]
        return (
          !actual ||
          actual.layer !== segment.layer ||
          Math.abs(actual.width - segment.width) > EPS ||
          distance(actual.start, segment.start) > EPS ||
          distance(actual.end, segment.end) > EPS
        )
      })
    )
      throw Error("Native plane recovery requires an unchanged leading prefix")
    prefix.push(plan)
  }
  const prefixIsClear = (plans: readonly FanoutRoutePlan[]) => {
    const routed = new Set(plans.map((p) => p.connectionIndex))
    return clear([
      ...accepted,
      ...plans,
      ...params.sourceEscapes
        .filter(
          (e) => own.has(e.connectionIndex) && !routed.has(e.connectionIndex),
        )
        .map(sourcePlan),
    ])
  }
  if (!prefixIsClear(prefix))
    throw Error(
      "Native plane recovery requires a physically clear leading prefix",
    )
  let blocked: ViaMinimalWindingTerminal | undefined
  for (const terminal of terminals.slice(prefix.length)) {
    const result = yield* single(terminal, [...accepted, ...prefix])
    const plan = result[0]?.[0]
    if (!plan) {
      blocked = terminal
      break
    }
    prefix.push(plan)
  }
  if (!blocked)
    return {
      plans: [...accepted, ...prefix],
      sourceEscapes: [...params.sourceEscapes],
    }
  const blockers: FanoutRoutePlan[] = []
  for (const omitted of prefix) {
    const result = yield* single(blocked, [
      ...accepted,
      ...prefix.filter((p) => p !== omitted),
    ])
    if (result[0]?.[0]) blockers.push(omitted)
  }
  const fail = (
    kind: NativePlaneRecoveryFailure["kind"],
    planeFailure?: SourceViaSiteFailure,
  ): null => {
    params.onFailure?.({
      kind,
      blockedConnectionIndex: blocked!.connection.connectionIndex,
      blockerConnectionIndices: blockers.map((p) => p.connectionIndex),
      prefixPlans: prefixIsClear(prefix)
        ? [...prefix]
        : [...(params.initialPlans ?? [])],
      ...(planeFailure ? { planeFailure } : {}),
    })
    return null
  }
  if (!blockers.length) return fail("no-blocker")
  if (params.stopAtFirstBlockedTerminal) return fail("routing")
  const moving = new Set([
    ...blockers.map((p) => p.connectionIndex),
    ...terminals.slice(prefix.length).map((t) => t.connection.connectionIndex),
  ])
  const fixed = prefix.filter((p) => !moving.has(p.connectionIndex))
  const local = terminals.filter((t) =>
    moving.has(t.connection.connectionIndex),
  )
  const signals = accepted.filter((p) => !planeIds.has(p.connectionIndex))
  const protectedPlanes = new Set<number>()
  const hard = params.sourceEscapes
    .filter((e) => !planeIds.has(e.connectionIndex))
    .map((e) => ({ connectionName: e.connectionName, via: e.via }))
  const soft = params.sourceEscapes
    .filter((e) => planeIds.has(e.connectionIndex))
    .map((e) => ({ connectionName: e.connectionName, via: e.via }))
  const rulesFor = (plans: FanoutRoutePlan[]): DogboneViaSiteGeometryRules => ({
    ...params,
    additionalObstacles: params.srj.obstacles,
    maximumSearchStates: nativeLimit,
    preferredViaPointsByConnectionIndex: new Map(
      params.sourceEscapes.map((e) => [e.connectionIndex, e.via.center]),
    ),
    blockingSegments: plans.flatMap((p) =>
      [...p.segments, ...(p.planeEndpointSegments ?? [])].map((segment) => ({
        connectionIndex: p.connectionIndex,
        segment,
      })),
    ),
    blockingVias: plans.flatMap((p) =>
      vias(p).map((via) => ({ connectionIndex: p.connectionIndex, ...via })),
    ),
  })
  const finish = (
    signalPlans: FanoutRoutePlan[],
    matched: Map<number, Point2D>,
    extension?: PeripheralSourceEscape,
  ): NativePlaneRecoveryResult | null => {
    const next = params.sourceEscapes.map((sourceEscape) => {
      if (extension?.connectionIndex === sourceEscape.connectionIndex)
        return extension
      const point = matched.get(sourceEscape.connectionIndex)
      if (!point) return sourceEscape
      const holder = holders.get(sourceEscape.connectionIndex)!
      return {
        ...sourceEscape,
        via: { ...sourceEscape.via, center: point },
        segments: [
          {
            start: holder.connection.sourcePoint,
            end: point,
            width: params.traceWidth,
            layer: holder.connection.sourceLayer,
          },
        ],
      }
    })
    const plans = [
      ...signalPlans,
      ...next.filter((e) => planeIds.has(e.connectionIndex)).map(sourcePlan),
    ]
    return clear(plans)
      ? { plans, sourceEscapes: next }
      : fail("plane-matching")
  }
  for (let round = 0; round < feedbackLimit; round++) {
    const alternatives = yield* routeViaMinimalWindingAlternativesSteps(
      {
        ...params,
        bus: { ...params.bus, connections: local.map((t) => t.connection) },
        terminals: local,
        acceptedPlans: [
          ...signals,
          ...fixed,
          ...accepted.filter((p) => protectedPlanes.has(p.connectionIndex)),
        ],
        sourceEscapePaths: sourcePaths,
        reservedVias: hard,
        softReservedVias: soft,
        maximumRouteOrderAttempts: params.maximumRouteOrderAttempts ?? 32,
        routeOrder: undefined,
        adaptiveRouteOrder: true,
        reserveTerminalExitPoints: true,
      },
      1,
      false,
    )
    const routed = alternatives[0]
    if (!routed) return fail("routing")
    const allSignals = [...signals, ...fixed, ...routed]
    const rules = rulesFor(allSignals)
    const native = getComponentDogboneViaSiteCandidates(planeBuses, rules)
    const supported = new Set(native.map((c) => c.connectionIndex))
    const zero = planeBuses.flatMap((bus) =>
      bus.connections.filter((c) => !supported.has(c.connectionIndex)),
    )
    const zeroIds = new Set(zero.map((c) => c.connectionIndex))
    const remaining = planeBuses
      .map((bus) => ({
        ...bus,
        connections: bus.connections.filter(
          (c) => !zeroIds.has(c.connectionIndex),
        ),
      }))
      .filter((bus) => bus.connections.length)
    let failure: SourceViaSiteFailure | undefined
    const matched = matchSourceViaSites(remaining, rules, (reason) => {
      failure = reason
    })
    if (!matched) {
      if (failure?.kind === "search-budget")
        return fail("plane-matching", failure)
      let added = false
      for (const id of failure?.connectionIndices ?? [])
        if (planeIds.has(id) && !protectedPlanes.has(id)) {
          protectedPlanes.add(id)
          added = true
        }
      if (!added) return fail("plane-matching", failure)
      continue
    }
    if (!zero.length) return finish(allSignals, matched)
    // A single local extension is deliberately bounded; a larger empty domain
    // set requires a different source topology instead of silent omission.
    if (zero.length !== 1)
      return fail("plane-matching", {
        kind: "empty-domains",
        connectionIndices: [...zeroIds],
      })
    const connection = zero[0]!
    const holder = holders.get(connection.connectionIndex)!
    const old = sources.get(connection.connectionIndex)!
    const pitch = Math.min(holder.bus.pitchX, holder.bus.pitchY)
    if (!Number.isFinite(pitch) || pitch <= 0) return fail("source-extension")
    const candidates: Point2D[] = []
    for (let x = -16; x <= 16; x++)
      for (let y = -16; y <= 16; y++) {
        const point = {
          x: connection.sourcePoint.x + (x * pitch) / 4,
          y: connection.sourcePoint.y + (y * pitch) / 4,
        }
        const bounds = params.bus.sharedBoundary
        if (
          distance(point, connection.sourcePoint) < params.viaDiameter ||
          point.x < bounds.minX + params.viaDiameter / 2 ||
          point.x > bounds.maxX - params.viaDiameter / 2 ||
          point.y < bounds.minY + params.viaDiameter / 2 ||
          point.y > bounds.maxY - params.viaDiameter / 2
        )
          continue
        if (
          params.srj.obstacles.some(
            (o) =>
              distancePointToObstacle(point, o) <
              params.viaDiameter / 2 + params.clearance - EPS,
          )
        )
          continue
        if (
          rules.blockingSegments?.some(
            (r) =>
              distancePointToSegment(point, r.segment.start, r.segment.end) <
              params.viaDiameter / 2 +
                r.segment.width / 2 +
                params.clearance -
                EPS,
          ) ||
          rules.blockingVias?.some(
            (v) =>
              distance(point, v.center) <
              (params.viaDiameter + v.diameter) / 2 + params.clearance - EPS,
          )
        )
          continue
        candidates.push(point)
      }
    candidates.sort(
      (a, b) =>
        distance(a, connection.sourcePoint) -
        distance(b, connection.sourcePoint),
    )
    for (const point of candidates.slice(0, planeLimit)) {
      const dx = point.x - connection.sourcePoint.x
      const dy = point.y - connection.sourcePoint.y
      const vertical = Math.abs(dy) >= Math.abs(dx)
      const exitEdge = vertical
        ? dy >= 0
          ? "top"
          : "bottom"
        : dx >= 0
          ? "right"
          : "left"
      const direction = vertical
        ? dy >= 0
          ? "up"
          : "down"
        : dx >= 0
          ? "right"
          : "left"
      const paths = yield* routeViaMinimalWindingAlternativesSteps(
        {
          ...params,
          srj: {
            ...params.srj,
            obstacles: params.srj.obstacles.filter(
              (o) => o !== connection.sourceObstacle,
            ),
          },
          bus: {
            ...holder.bus,
            exitEdge,
            direction,
            connections: [connection],
          },
          targetLayer: connection.sourceLayer,
          terminals: [
            {
              connection,
              viaPoint: connection.sourcePoint,
              exitPoint: point,
            },
          ],
          acceptedPlans: allSignals,
          sourceEscapePaths: new Map([
            [
              connection.connectionIndex,
              [connection.sourcePoint, connection.sourcePoint],
            ],
          ]),
          reservedVias: [],
          softReservedVias: soft.filter(
            (v) => v.connectionName !== connection.connection.name,
          ),
          allowSourceLayerRouting: true,
          viaDiameter: 0,
          viaHoleDiameter: 0,
          maximumRouteOrderAttempts: 1,
          routeOrder: undefined,
          alignGridToPads: true,
          gridStepDivisor: 2,
          gridStep: undefined,
        },
        1,
        false,
      )
      const path = paths[0]?.[0]
      if (!path) continue
      const extension = {
        ...old,
        via: { ...old.via, center: point },
        segments: path.segments,
      }
      const held = [...allSignals, sourcePlan(extension)]
      if (!clear(held)) continue
      const rest = matchSourceViaSites(remaining, rulesFor(held))
      if (!rest) continue
      const result = finish(allSignals, rest, extension)
      if (result) return result
    }
    return fail("source-extension")
  }
  return fail("feedback-limit")
}
