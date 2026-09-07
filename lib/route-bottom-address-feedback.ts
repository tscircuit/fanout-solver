import { distance } from "./geometry"
import { getBottomPerimeterSourceCandidates } from "./get-bottom-perimeter-source-candidates"
import { getSourceTailEndpointCandidates } from "./get-source-tail-endpoint-candidates"
import {
  type BottomSourceInitialization,
  initializeBottomSourcesSteps,
} from "./initialize-bottom-sources"
import { getComponentDogboneViaSiteCandidates } from "./match-component-dogbone-via-sites"
import { repairSourceViaChain } from "./repair-source-via-chain"
import { routeBottomSourceLayerRecoverySteps } from "./route-bottom-source-layer-recovery"
import { fanoutPlansAreClear, type RouteBusParams } from "./route-bus"
import {
  type NativePlaneRecoveryFailure,
  routeBusWithNativePlaneRecoverySteps,
} from "./route-bus-with-native-plane-recovery"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import {
  buildViaMinimalWindingPlan,
  type RouteViaMinimalWindingProgress,
  routeViaMinimalWindingAlternativesSteps,
} from "./route-via-minimal-winding"
import type {
  Bounds,
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "./types"

export interface BottomAddressFeedbackParams
  extends Omit<RouteBusParams, "acceptedPlans"> {
  preparedBuses: readonly PreparedBus[]
  targetLayerByBusId: ReadonlyMap<string, string>
  maximumSourceFeedbackRounds?: number
  maximumSourceCandidateChecks?: number
  maximumNeighborSources?: number
  sourceStrategy?:
    | "legacy"
    | "expanded-first"
    | "legacy-then-expanded"
    | "expanded-then-legacy"
  onCheckpoint?: (checkpoint: BottomAddressFeedbackCheckpoint) => void
  onFeedback?: (event: {
    phase: string
    prefixCount: number
    connectionIndex?: number
    neighborConnectionIndex?: number
    candidateChecks: number
    strategy?: "legacy" | "expanded-first"
  }) => void
}
export interface BottomAddressFeedbackCheckpoint {
  sourceEscapes: readonly PeripheralSourceEscape[]
  plans: readonly FanoutRoutePlan[]
  prefixPlans: readonly FanoutRoutePlan[]
  sourceBoundary: Bounds
  failure?: NativePlaneRecoveryFailure
}
export interface BottomAddressFeedbackResult {
  plans: FanoutRoutePlan[]
  source: BottomSourceInitialization
}
interface SourceState {
  sourceEscapes: PeripheralSourceEscape[]
  plans: FanoutRoutePlan[]
}
/** Route a whole boundary bus from original prepared geometry. Only unfinished
 * sources and ordinary plane sites may move; every retained prefix remains real
 * copper throughout feedback. Source-only routes in the result still require
 * their original buses to be completed by the caller. */
export function* routeBottomAddressFeedbackSteps(
  params: BottomAddressFeedbackParams,
): Generator<unknown, BottomAddressFeedbackResult | null, void> {
  const rounds = params.maximumSourceFeedbackRounds ?? 12
  const checkLimit = params.maximumSourceCandidateChecks ?? 4096
  const neighborLimit = params.maximumNeighborSources ?? 3
  if (
    [rounds, checkLimit, neighborLimit].some(
      (n) => !Number.isSafeInteger(n) || n < 1,
    )
  )
    throw Error("Address feedback requires positive finite budgets")
  if (
    params.bus.exitEdge !== "bottom" ||
    params.bus.termination.type !== "boundary" ||
    params.allowSameNetMerges ||
    params.allowBlindAndBuriedVias
  )
    return null
  const initialized = yield* initializeBottomSourcesSteps({
    ...params,
    buses: [...params.preparedBuses],
    maximumCandidateChecks: 128,
    promotionPolicy: "inversion-first",
    shortenSeed: true,
  })
  if (!initialized) return null
  let totalChecks = 0
  const strategies =
    params.sourceStrategy === "legacy"
      ? (["legacy"] as const)
      : params.sourceStrategy === "expanded-first"
        ? (["expanded-first"] as const)
        : params.sourceStrategy === "legacy-then-expanded"
          ? (["legacy", "expanded-first"] as const)
          : (["expanded-first", "legacy"] as const)
  for (const strategy of strategies) {
    const remaining = checkLimit - totalChecks
    if (remaining <= 0) break
    const recovered = yield* routeInitializedBottomAddressFeedbackSteps(
      {
        ...params,
        maximumSourceCandidateChecks:
          strategy === "legacy" && strategies.length > 1
            ? Math.min(512, remaining)
            : remaining,
        onFeedback: (event) =>
          params.onFeedback?.({
            ...event,
            candidateChecks: totalChecks,
            strategy,
          }),
      },
      initialized,
      strategy === "expanded-first",
      () => {
        totalChecks++
      },
    )
    if (recovered)
      return {
        ...recovered,
        source: {
          ...recovered.source,
          checks: initialized.checks + totalChecks,
        },
      }
  }
  return null
}

function* routeInitializedBottomAddressFeedbackSteps(
  params: BottomAddressFeedbackParams,
  initialized: BottomSourceInitialization,
  expandedFirst: boolean,
  countSourceCandidate: () => void,
): Generator<unknown, BottomAddressFeedbackResult | null, void> {
  const rounds = params.maximumSourceFeedbackRounds ?? 12
  const checkLimit = params.maximumSourceCandidateChecks ?? 4096
  const neighborLimit = params.maximumNeighborSources ?? 3
  const bus = params.bus
  const own = new Set(bus.connections.map((c) => c.connectionIndex))
  const holders = new Map(
    params.preparedBuses.flatMap((b) =>
      b.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus: b, connection }] as const,
      ),
    ),
  )
  const planeIds = new Set(
    params.preparedBuses
      .filter((b) => b.termination.type === "plane")
      .flatMap((b) => b.connections.map((c) => c.connectionIndex)),
  )
  const terminalOrder = bus.connections.toSorted(
    (a, b) =>
      (a.exitTargetPoint ?? a.targetPoint).x -
      (b.exitTargetPoint ?? b.targetPoint).x,
  )
  const sourceBoundary = initialized.sourceBoundary
  let state: SourceState = {
    sourceEscapes: initialized.sourceEscapes,
    plans: initialized.plans,
  }
  let prefix: FanoutRoutePlan[] = []
  let candidateChecks = 0
  let preferExpandedSource = expandedFirst
  const emit = (
    phase: string,
    connectionIndex?: number,
    neighborConnectionIndex?: number,
  ) =>
    params.onFeedback?.({
      phase,
      prefixCount: prefix.length,
      connectionIndex,
      neighborConnectionIndex,
      candidateChecks,
    })
  const stub = (sourceEscape: PeripheralSourceEscape): FanoutRoutePlan => {
    const h = holders.get(sourceEscape.connectionIndex)!
    const plan = buildViaMinimalWindingPlan({
      ...params,
      allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
      bus: h.bus,
      targetLayer: sourceEscape.via.toLayer,
      terminal: {
        connection: h.connection,
        viaPoint: sourceEscape.via.center,
        exitPoint: sourceEscape.via.center,
      },
      sourceEscapePoints: [
        sourceEscape.segments[0]!.start,
        ...sourceEscape.segments.map((s) => s.end),
      ],
      targetLayerPoints: [sourceEscape.via.center, sourceEscape.via.center],
    })
    return {
      ...plan,
      via: sourceEscape.via,
      termination: { type: "plane", layer: sourceEscape.via.toLayer },
      sourceEscapeSegmentCount: sourceEscape.segments.length,
    }
  }
  const withPrefix = (
    s: SourceState,
    plans: readonly FanoutRoutePlan[],
  ): SourceState => {
    const routed = new Map(plans.map((p) => [p.connectionIndex, p]))
    return {
      sourceEscapes: s.sourceEscapes,
      plans: s.sourceEscapes.map(
        (e) =>
          routed.get(e.connectionIndex) ??
          s.plans.find((p) => p.connectionIndex === e.connectionIndex) ??
          stub(e),
      ),
    }
  }
  const clear = (plans: FanoutRoutePlan[]) =>
    fanoutPlansAreClear({
      ...params,
      plans,
      sharedBoundary: bus.sharedBoundary,
    })
  const finish = (s: SourceState): BottomAddressFeedbackResult => {
    if (!clear(s.plans))
      throw Error("Address feedback failed complete source clearance")
    const sourcePlans = s.sourceEscapes.map(stub)
    const remoteConnectionIndices = new Set(initialized.remoteConnectionIndices)
    for (const e of s.sourceEscapes)
      if (own.has(e.connectionIndex) && e.segments.length > 1)
        remoteConnectionIndices.add(e.connectionIndex)
    return {
      plans: s.plans,
      source: {
        ...initialized,
        sourceEscapes: s.sourceEscapes,
        viaPointsByConnectionIndex: new Map(
          s.sourceEscapes.map((e) => [e.connectionIndex, e.via.center]),
        ),
        remoteConnectionIndices,
        plans: sourcePlans,
        checks: initialized.checks + candidateChecks,
      },
    }
  }
  function* routeRequested(
    s: SourceState,
    connection: PreparedConnection,
  ): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan | null, void> {
    const sourceBy = new Map(s.sourceEscapes.map((e) => [e.connectionIndex, e]))
    const source = sourceBy.get(connection.connectionIndex)!
    const prefixIds = new Set(prefix.map((p) => p.connectionIndex))
    const acceptedPlans = s.plans.filter(
      (p) => !own.has(p.connectionIndex) || prefixIds.has(p.connectionIndex),
    )
    const paths = new Map(
      s.sourceEscapes.map((e) => [
        e.connectionIndex,
        [e.segments[0]!.start, ...e.segments.map((segment) => segment.end)],
      ]),
    )
    const alternatives = yield* routeViaMinimalWindingAlternativesSteps(
      {
        ...params,
        bus: { ...bus, connections: [connection] },
        terminals: [
          {
            connection,
            viaPoint: source.via.center,
            exitPoint: {
              x: (connection.exitTargetPoint ?? connection.targetPoint).x,
              y: bus.sharedBoundary.minY,
            },
          },
        ],
        acceptedPlans,
        sourceEscapePaths: paths,
        reservedVias: [
          ...s.sourceEscapes.map((e) => ({
            connectionName: e.connectionName,
            via: e.via,
          })),
          ...terminalOrder.map((c) => ({
            connectionName: c.connection.name,
            via: {
              center: {
                x: (c.exitTargetPoint ?? c.targetPoint).x,
                y: bus.sharedBoundary.minY,
              },
              diameter: params.traceWidth,
              spanLayers: [params.targetLayer],
            },
          })),
        ],
        gridStep: params.traceWidth,
        gridStepDivisor: 2,
        alignGridToPads: true,
        maximumRouteOrderAttempts: 1,
        routeOrder: [0],
        laneBias: -1,
      },
      1,
      false,
    )
    const plan = alternatives[0]?.[0]
    return plan &&
      clear(
        s.plans.map((p) =>
          p.connectionIndex === connection.connectionIndex ? plan : p,
        ),
      )
      ? plan
      : null
  }
  function repairRequestedState(
    s: SourceState,
    connection: PreparedConnection,
    candidate: PeripheralSourceEscape,
  ): SourceState | null {
    if (candidateChecks >= checkLimit) return null
    candidateChecks++
    countSourceCandidate()
    const repaired = repairSourceViaChain({
      ...params,
      buses: params.preparedBuses,
      sourceEscapes: s.sourceEscapes.filter(
        (e) =>
          e.connectionIndex === connection.connectionIndex ||
          planeIds.has(e.connectionIndex),
      ),
      acceptedPlans: s.plans,
      requestedEscape: candidate,
      maximumMovedConnections: 4,
      maximumSearchStates: 8192,
    })
    if (!repaired) return null
    if (
      repaired.changedConnectionIndices.some(
        (id) => id !== connection.connectionIndex && !planeIds.has(id),
      )
    )
      throw Error("Address feedback changed an immutable signal source")
    const updates = new Map(
      repaired.sourceEscapes.map((e) => [e.connectionIndex, e]),
    )
    return {
      sourceEscapes: s.sourceEscapes.map(
        (e) => updates.get(e.connectionIndex) ?? e,
      ),
      plans: repaired.sourcePlans,
    }
  }
  function* perimeterStates(
    s: SourceState,
    connection: PreparedConnection,
    expanded = false,
  ): Generator<SourceState, void, void> {
    const old = s.sourceEscapes.find(
      (e) => e.connectionIndex === connection.connectionIndex,
    )!
    let candidateIndex = 0
    for (const candidate of getBottomPerimeterSourceCandidates({
      ...params,
      connection,
      sourceEscape: old,
      sourceBoundary,
      maximumCandidates: expanded ? 1024 : 128,
    })) {
      if (expanded && candidateIndex++ < 128) continue
      if (candidateChecks >= checkLimit) return
      const repaired = repairRequestedState(s, connection, candidate)
      if (repaired) yield repaired
    }
  }
  for (let round = 0; round < rounds; round++) {
    let failure: NativePlaneRecoveryFailure | undefined
    const sourceBy = new Map(
      state.sourceEscapes.map((e) => [e.connectionIndex, e]),
    )
    const recovered = yield* routeBusWithNativePlaneRecoverySteps({
      ...params,
      preparedBuses: params.preparedBuses,
      acceptedPlans: state.plans.filter((p) => !own.has(p.connectionIndex)),
      initialPlans: prefix,
      sourceEscapes: state.sourceEscapes,
      terminals: bus.connections.map((connection) => ({
        connection,
        viaPoint: sourceBy.get(connection.connectionIndex)!.via.center,
        exitPoint: {
          x: (connection.exitTargetPoint ?? connection.targetPoint).x,
          y: bus.sharedBoundary.minY,
        },
      })),
      gridStep: params.traceWidth,
      gridStepDivisor: 2,
      alignGridToPads: true,
      stopAtFirstBlockedTerminal: true,
      onFailure: (reason) => {
        failure = reason
      },
    })
    if (recovered) {
      prefix = recovered.plans.filter((p) => own.has(p.connectionIndex))
      state = { sourceEscapes: recovered.sourceEscapes, plans: recovered.plans }
      emit("complete")
      return finish(state)
    }
    if (!failure) return null
    prefix = [...failure.prefixPlans]
    state = withPrefix(state, prefix)
    if (!clear(state.plans))
      throw Error("Address feedback received an invalid source/prefix context")
    params.onCheckpoint?.({
      sourceEscapes: state.sourceEscapes,
      plans: state.plans,
      prefixPlans: [...prefix],
      sourceBoundary,
      failure,
    })
    const connection = holders.get(failure.blockedConnectionIndex)!.connection
    emit("blocked", connection.connectionIndex)
    let acceptedState: SourceState | undefined
    let acceptedPlan: FanoutRoutePlan | null = null
    // Sliding an existing source tail is cheaper than opening a new perimeter.
    // Native one-segment dogbones have no tail alternatives.
    const oldSource = state.sourceEscapes.find(
      (source) => source.connectionIndex === connection.connectionIndex,
    )!
    for (const sourceCandidate of getSourceTailEndpointCandidates({
      ...params,
      connection,
      sourceEscape: oldSource,
    })) {
      const candidate = repairRequestedState(state, connection, sourceCandidate)
      if (!candidate) continue
      const plan = yield* routeRequested(candidate, connection)
      if (!plan) continue
      acceptedState = candidate
      acceptedPlan = plan
      emit("source-tail", connection.connectionIndex)
      break
    }
    for (const candidate of acceptedState
      ? []
      : perimeterStates(state, connection)) {
      const plan = yield* routeRequested(candidate, connection)
      if (plan) {
        acceptedState = candidate
        acceptedPlan = plan
        preferExpandedSource = false
        emit("perimeter-source", connection.connectionIndex)
        break
      }
    }
    if (!acceptedState && preferExpandedSource) {
      for (const candidate of perimeterStates(state, connection, true)) {
        const plan = yield* routeRequested(candidate, connection)
        if (plan) {
          acceptedState = candidate
          acceptedPlan = plan
          preferExpandedSource = false
          emit("expanded-perimeter-source", connection.connectionIndex)
          break
        }
      }
    }
    if (
      !acceptedState &&
      failure.blockerConnectionIndices.length > 0 &&
      failure.blockerConnectionIndices.length < 4
    ) {
      const localIds = new Set([
        ...failure.blockerConnectionIndices,
        connection.connectionIndex,
      ])
      const localBus = {
        ...bus,
        connections: bus.connections.filter((c) =>
          localIds.has(c.connectionIndex),
        ),
      }
      const local = yield* routeBusWithNativePlaneRecoverySteps({
        ...params,
        bus: localBus,
        preparedBuses: params.preparedBuses,
        acceptedPlans: state.plans.filter(
          (p) => !localIds.has(p.connectionIndex),
        ),
        sourceEscapes: state.sourceEscapes,
        terminals: localBus.connections.map((c) => ({
          connection: c,
          viaPoint: sourceBy.get(c.connectionIndex)!.via.center,
          exitPoint: {
            x: (c.exitTargetPoint ?? c.targetPoint).x,
            y: bus.sharedBoundary.minY,
          },
        })),
        gridStep: params.traceWidth,
        gridStepDivisor: 2,
        alignGridToPads: true,
        maximumRouteOrderAttempts: 16,
        adaptiveRouteOrder: true,
        reserveTerminalExitPoints: true,
      })
      if (local) {
        const byPlan = new Map(local.plans.map((p) => [p.connectionIndex, p]))
        prefix = prefix.map((p) => byPlan.get(p.connectionIndex)!)
        acceptedState = local
        acceptedPlan = byPlan.get(connection.connectionIndex)!
        emit("local-routes", connection.connectionIndex)
      }
    }
    if (!acceptedState && candidateChecks >= checkLimit) return null
    if (!acceptedState) {
      const repaired = yield* routeBottomSourceLayerRecoverySteps({
        ...params,
        preparedBuses: params.preparedBuses,
        sourceEscapes: state.sourceEscapes,
        plans: state.plans,
        connection,
        sourceBoundary,
      })
      if (repaired) {
        const plan = yield* routeRequested(repaired, connection)
        if (plan) {
          acceptedState = repaired
          acceptedPlan = plan
          emit("source-layer", connection.connectionIndex)
        }
      }
    }
    if (!acceptedState) {
      const prefixIds = new Set(prefix.map((p) => p.connectionIndex))
      const bySource = new Map(
        state.sourceEscapes.map((e) => [e.connectionIndex, e]),
      )
      const neighbors = terminalOrder
        .filter(
          (c) =>
            c.connectionIndex !== connection.connectionIndex &&
            !prefixIds.has(c.connectionIndex) &&
            bySource.get(c.connectionIndex)!.segments.length > 1 &&
            c.sourceLayer === connection.sourceLayer,
        )
        .toSorted(
          (a, b) =>
            distance(a.sourcePoint, connection.sourcePoint) -
              distance(b.sourcePoint, connection.sourcePoint) ||
            bySource.get(a.connectionIndex)!.segments.length -
              bySource.get(b.connectionIndex)!.segments.length ||
            (a.exitTargetPoint ?? a.targetPoint).x -
              (b.exitTargetPoint ?? b.targetPoint).x,
        )
        .slice(0, neighborLimit)
      for (const neighbor of neighbors) {
        let feasibleCandidates = 0
        for (const candidate of perimeterStates(state, neighbor)) {
          if (++feasibleCandidates > 2) break
          const repaired = yield* routeBottomSourceLayerRecoverySteps({
            ...params,
            preparedBuses: params.preparedBuses,
            sourceEscapes: candidate.sourceEscapes,
            plans: candidate.plans,
            connection,
            sourceBoundary,
          })
          if (!repaired) continue
          const plan = yield* routeRequested(repaired, connection)
          if (plan) {
            acceptedState = repaired
            acceptedPlan = plan
            emit(
              "neighbor-source",
              connection.connectionIndex,
              neighbor.connectionIndex,
            )
            break
          }
        }
        if (acceptedState) break
      }
    }
    if (!acceptedState) {
      const old = state.sourceEscapes.find(
        (source) => source.connectionIndex === connection.connectionIndex,
      )!
      const candidates = [
        ...getSourceTailEndpointCandidates({
          ...params,
          connection,
          sourceEscape: old,
        }),
        ...getComponentDogboneViaSiteCandidates(
          [{ ...bus, connections: [connection] }],
          { ...params, additionalObstacles: params.srj.obstacles },
        ).map(
          ({ point }): PeripheralSourceEscape => ({
            ...old,
            via: { ...old.via, center: point },
            segments: [
              {
                start: connection.sourcePoint,
                end: point,
                layer: connection.sourceLayer,
                width: params.traceWidth,
              },
            ],
          }),
        ),
      ]
      for (const sourceCandidate of candidates) {
        const candidate = repairRequestedState(
          state,
          connection,
          sourceCandidate,
        )
        if (!candidate) continue
        const plan = yield* routeRequested(candidate, connection)
        if (plan) {
          acceptedState = candidate
          acceptedPlan = plan
          emit("source-endpoint", connection.connectionIndex)
          break
        }
      }
    }
    if (!acceptedState && !preferExpandedSource) {
      for (const candidate of perimeterStates(state, connection, true)) {
        const plan = yield* routeRequested(candidate, connection)
        if (plan) {
          acceptedState = candidate
          acceptedPlan = plan
          emit("expanded-perimeter-source", connection.connectionIndex)
          break
        }
      }
    }
    if (!acceptedState) {
      const prefixIds = new Set(prefix.map((p) => p.connectionIndex))
      const bySource = new Map(
        state.sourceEscapes.map((e) => [e.connectionIndex, e]),
      )
      const neighbors = terminalOrder
        .filter(
          (c) =>
            c.connectionIndex !== connection.connectionIndex &&
            !prefixIds.has(c.connectionIndex) &&
            bySource.get(c.connectionIndex)!.segments.length > 1 &&
            c.sourceLayer === connection.sourceLayer,
        )
        .toSorted(
          (a, b) =>
            distance(a.sourcePoint, connection.sourcePoint) -
              distance(b.sourcePoint, connection.sourcePoint) ||
            bySource.get(a.connectionIndex)!.segments.length -
              bySource.get(b.connectionIndex)!.segments.length ||
            (a.exitTargetPoint ?? a.targetPoint).x -
              (b.exitTargetPoint ?? b.targetPoint).x,
        )
        .slice(0, neighborLimit)
      for (const neighbor of neighbors) {
        let feasibleCandidates = 0
        for (const candidate of perimeterStates(state, neighbor, true)) {
          if (++feasibleCandidates > 2) break
          const repaired = yield* routeBottomSourceLayerRecoverySteps({
            ...params,
            preparedBuses: params.preparedBuses,
            sourceEscapes: candidate.sourceEscapes,
            plans: candidate.plans,
            connection,
            sourceBoundary,
          })
          if (!repaired) continue
          const plan = yield* routeRequested(repaired, connection)
          if (plan) {
            acceptedState = repaired
            acceptedPlan = plan
            emit(
              "expanded-neighbor-source",
              connection.connectionIndex,
              neighbor.connectionIndex,
            )
            break
          }
        }
        if (acceptedState) break
      }
    }
    if (!acceptedState) {
      const recovered = yield* routeBusWithNativePlaneRecoverySteps({
        ...params,
        preparedBuses: params.preparedBuses,
        acceptedPlans: state.plans.filter((p) => !own.has(p.connectionIndex)),
        initialPlans: prefix,
        sourceEscapes: state.sourceEscapes,
        terminals: bus.connections.map((connection) => ({
          connection,
          viaPoint: sourceBy.get(connection.connectionIndex)!.via.center,
          exitPoint: {
            x: (connection.exitTargetPoint ?? connection.targetPoint).x,
            y: bus.sharedBoundary.minY,
          },
        })),
        gridStep: params.traceWidth,
        gridStepDivisor: 2,
        alignGridToPads: true,
        maximumRouteOrderAttempts: 32,
        adaptiveRouteOrder: true,
        reserveTerminalExitPoints: true,
      })
      if (recovered)
        return finish({
          sourceEscapes: recovered.sourceEscapes,
          plans: recovered.plans,
        })
    }
    if (!acceptedState || !acceptedPlan) return null
    state = acceptedState
    prefix.push(acceptedPlan)
    state = withPrefix(state, prefix)
  }
  return null
}
