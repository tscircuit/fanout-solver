import { getCornerBandSide, getDirectionForExitEdge } from "./boundary-exit"
import {
  createOrthogonalFanoutView,
  type OrthogonalMatrix,
} from "./orthogonal-fanout-view"
import { routeAdaptiveLeftCrossbarBusSteps } from "./route-adaptive-left-crossbar-bus"
import { routeBottomCrossbarBusSteps } from "./route-bottom-crossbar-bus"
import {
  fanoutPlansAreClear,
  getBoundaryTargetTrack,
  getCornerTargetTrack,
  type RouteBusAlternativesProgress,
  type RouteBusParams,
} from "./route-bus"
import {
  routeExtendedDeclaredLayerBridgeSteps as routeExtendedBridgeSteps,
  routeShortDeclaredLayerBridgeSteps as routeShortBridgeSteps,
} from "./route-declared-layer-bridge"
import { routeLeftCrossbarBusSteps } from "./route-left-crossbar-bus"
import { routeNarrowWindingPreflightSteps } from "./route-narrow-winding-preflight"
import { routeOppositeBottomCrossbarBusSteps } from "./route-opposite-bottom-crossbar-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import { routeReservedSourceBusesSteps } from "./route-reserved-source-buses"
import {
  buildViaMinimalWindingPlan,
  type RouteViaMinimalWindingProgress,
  routeViaMinimalWindingAlternativesSteps,
  type ViaMinimalWindingTerminal,
} from "./route-via-minimal-winding"
import type { Bounds, FanoutRoutePlan, PreparedBus } from "./types"

export interface FreshReservedBusesParams
  extends Omit<RouteBusParams, "bus" | "targetLayer" | "acceptedPlans"> {
  /** All prepared buses are required to reserve every pending source escape. */
  preparedBuses: readonly PreparedBus[]
  /** A subset may be completed before another bus is routed. Defaults to all. */
  buses?: readonly PreparedBus[]
  sourceEscapes: readonly PeripheralSourceEscape[]
  sourceBoundary: Bounds
  initialPlans: readonly FanoutRoutePlan[]
  targetLayerByBusId?: ReadonlyMap<string, string>
  onBusComplete?: (
    bus: PreparedBus,
    plans: readonly FanoutRoutePlan[],
    method: string,
  ) => void
}

/** Complete fresh buses with immutable sources, preserving whole accepted buses.
 * This returns physical routes; callers must run normal complete-layout length matching.
 */
export function* routeFreshReservedBusesSteps(
  params: FreshReservedBusesParams,
): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[] | null, void> {
  const buses = params.buses ?? params.preparedBuses
  const byIndex = new Map(
    params.preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const restorePlans = (
    view: ReturnType<typeof createOrthogonalFanoutView>,
    plans: readonly FanoutRoutePlan[],
  ): FanoutRoutePlan[] =>
    plans.map((plan) =>
      view.restorePlan(plan, byIndex.get(plan.connectionIndex)!.connection),
    )
  const sources = new Map(
    params.sourceEscapes.map((source) => [source.connectionIndex, source]),
  )
  if (
    sources.size !== byIndex.size ||
    sources.size !== params.sourceEscapes.length
  )
    throw new Error(
      "Fresh continuation requires one source escape for every original connection",
    )
  const sourcePlans = params.sourceEscapes.map((source) => {
    const owner = byIndex.get(source.connectionIndex)
    if (!owner)
      throw new Error("Source escape does not belong to a prepared bus")
    const plan = buildViaMinimalWindingPlan({
      ...params,
      bus: owner.bus,
      targetLayer: source.via.toLayer,
      terminal: {
        connection: owner.connection,
        viaPoint: source.via.center,
        exitPoint: source.via.center,
      },
      sourceEscapePoints: [
        source.segments[0]!.start,
        ...source.segments.map((segment) => segment.end),
      ],
      targetLayerPoints: [source.via.center, source.via.center],
      allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
    })
    plan.termination = { type: "plane", layer: source.via.toLayer }
    plan.via = source.via
    plan.sourceEscapeSegmentCount = source.segments.length
    return plan
  })
  const mergeSources = (plans: readonly FanoutRoutePlan[]) => {
    const merged = new Map(
      sourcePlans.map((plan) => [plan.connectionIndex, plan]),
    )
    for (const plan of plans) merged.set(plan.connectionIndex, plan)
    return [...merged.values()]
  }
  const accepted = [...params.initialPlans]
  const completed = new Set<number>(
    accepted.map((plan) => plan.connectionIndex),
  )
  if (completed.size !== accepted.length)
    throw new Error("Initial plans contain duplicate connections")
  for (const bus of params.preparedBuses) {
    const count = bus.connections.filter((connection) =>
      completed.has(connection.connectionIndex),
    ).length
    if (count > 0 && count !== bus.connections.length)
      throw new Error("Fresh continuation cannot commit a partial bus")
  }
  const sharedBoundary = params.preparedBuses[0]?.sharedBoundary
  if (
    !sharedBoundary ||
    !fanoutPlansAreClear({
      ...params,
      plans: mergeSources(accepted),
      sharedBoundary,
    })
  )
    throw new Error(
      "Fresh continuation starts from invalid copper or reserved sources",
    )
  const sourceEscapePaths = new Map(
    params.sourceEscapes.map((source) => [
      source.connectionIndex,
      [
        source.segments[0]!.start,
        ...source.segments.map((segment) => segment.end),
      ],
    ]),
  )
  const fixedViaPointsByConnectionIndex = new Map(
    params.sourceEscapes.map((source) => [
      source.connectionIndex,
      source.via.center,
    ]),
  )
  const reservedVias = params.sourceEscapes.map((source) => ({
    connectionName: source.connectionName,
    via: source.via,
  }))
  const layerFor = (bus: PreparedBus) =>
    params.targetLayerByBusId?.get(bus.busId) ??
    (bus.termination.type === "plane"
      ? bus.termination.layer
      : sources.get(bus.connections[0]!.connectionIndex)!.via.toLayer)
  const pending = buses.toSorted(
    (a, b) =>
      Number(b.termination.type === "boundary") -
        Number(a.termination.type === "boundary") ||
      b.connections.length - a.connections.length,
  )
  for (const bus of pending) {
    if (
      bus.connections.every((connection) =>
        completed.has(connection.connectionIndex),
      )
    )
      continue
    const targetLayer = layerFor(bus)
    const group =
      bus.termination.type === "boundary" && bus.connections.length <= 2
        ? pending.filter(
            (candidate) =>
              candidate.termination.type === "boundary" &&
              candidate.connections.length <= 2 &&
              layerFor(candidate) === targetLayer &&
              candidate.connections.every(
                (connection) => !completed.has(connection.connectionIndex),
              ),
          )
        : [bus]
    const own = new Set(
      group.flatMap((candidate) =>
        candidate.connections.map((connection) => connection.connectionIndex),
      ),
    )
    const foreign = mergeSources(accepted).filter(
      (plan) => !own.has(plan.connectionIndex),
    )
    const allowed = bus.routableEscapeLayers ?? bus.allowedLayers ?? []
    const sourceLayer = bus.connections[0]!.sourceLayer
    let routed: FanoutRoutePlan[] | null = null
    let method = "ordinary"
    const planeLayer =
      bus.termination.type === "plane" ? bus.termination.layer : undefined
    const reservedPlane =
      planeLayer !== undefined &&
      bus.connections.every(
        (connection) =>
          sources.get(connection.connectionIndex)!.via.toLayer === planeLayer,
      )
    if (reservedPlane) {
      routed = sourcePlans.filter((plan) => own.has(plan.connectionIndex))
      method = "reserved-plane-drop"
    }
    const terminalsFor = (
      windingOrderIndex?: number,
      trackBus: PreparedBus = bus,
    ): ViaMinimalWindingTerminal[] => {
      if (!bus.exitEdge) return []
      return bus.connections.map((connection) => {
        const track = getCornerBandSide(bus.exitEdge, trackBus.preferredExit)
          ? getCornerTargetTrack({
              ...params,
              bus: trackBus,
              connection,
              targetLayer,
              cornerExitLaneOffset: 0,
              windingOrderIndex,
            })
          : getBoundaryTargetTrack({
              ...params,
              bus,
              connection,
              targetLayer,
              boundaryDirection: getDirectionForExitEdge(bus.exitEdge!),
              windingOrderIndex,
            })
        const b = bus.sharedBoundary
        const exitPoint =
          bus.exitEdge === "left"
            ? { x: b.minX, y: track }
            : bus.exitEdge === "right"
              ? { x: b.maxX, y: track }
              : bus.exitEdge === "top"
                ? { x: track, y: b.maxY }
                : { x: track, y: b.minY }
        return {
          connection,
          viaPoint: sources.get(connection.connectionIndex)!.via.center,
          exitPoint,
        }
      })
    }
    function* winding<T>(
      steps: Generator<RouteViaMinimalWindingProgress, T, void>,
    ): Generator<RouteBusAlternativesProgress, T, void> {
      let step = steps.next()
      while (!step.done) {
        yield {
          phase: "via-minimal-winding",
          busId: bus.busId,
          targetLayer,
          winding: step.value,
        }
        step = steps.next()
      }
      return step.value
    }
    const wide =
      bus.termination.type === "boundary" &&
      bus.connections.length > 2 &&
      bus.exitEdge
    // When the only crossover is the source layer, first try the canonical
    // layered target interleave with a target-directed native winding order.
    if (
      wide &&
      allowed.every((layer) => layer === sourceLayer || layer === targetLayer)
    ) {
      const terminals = terminalsFor(0)
      const axis =
        bus.exitEdge === "left" || bus.exitEdge === "right" ? "y" : "x"
      const toward = Math.sign(
        terminals.reduce(
          (sum, t) => sum + t.exitPoint[axis] - t.viaPoint[axis],
          0,
        ),
      ) as -1 | 0 | 1
      const alternatives = yield* winding(
        routeViaMinimalWindingAlternativesSteps(
          {
            ...params,
            bus,
            targetLayer,
            terminals,
            acceptedPlans: foreign,
            sourceEscapePaths,
            reservedVias,
            gridStep: (params.traceWidth + params.clearance) / 2,
            alignGridToPads: true,
            maximumRouteOrderAttempts: 1,
            routeOrder: terminals
              .map((_, index) => index)
              .sort(
                (a, b) =>
                  terminals[a]!.exitPoint[axis] - terminals[b]!.exitPoint[axis],
              ),
            laneBias: toward,
          },
          1,
          false,
        ),
      )
      routed = alternatives[0] ?? null
      method = "direct-canonical-targets"
    }
    // A declared non-source crossover can repair a blocked lane without
    // changing any source path or the target layer of its final edge run.
    if (
      !routed &&
      wide &&
      allowed.some((layer) => layer !== targetLayer && layer !== sourceLayer)
    ) {
      const matrix: OrthogonalMatrix =
        bus.exitEdge === "bottom"
          ? [0, 1, -1, 0]
          : bus.exitEdge === "top"
            ? [0, -1, 1, 0]
            : bus.exitEdge === "right"
              ? [-1, 0, 0, 1]
              : [1, 0, 0, 1]
      const view = createOrthogonalFanoutView(matrix)
      const transformed = view.toCanonical({
        ...params,
        staticClearanceCache: undefined,
        bus,
        targetLayer,
        terminals: terminalsFor(),
        acceptedPlans: accepted,
        sourcePlans,
      })
      // Repair the first small blocked set before expanding route ordering.
      // If it cannot complete, retain the broader existing search unchanged.
      let result = getCornerBandSide(bus.exitEdge!, bus.preferredExit)
        ? yield* winding(
            routeExtendedBridgeSteps({
              ...transformed,
              maximumDirectOrders: 6,
              maximumSearches: 128,
            }),
          )
        : null
      let resultView = view
      if (!result && getCornerBandSide(bus.exitEdge!, bus.preferredExit)) {
        // The native axes may expose a different small blocked set. Reserve
        // enough searches for two local bridges before expanding direct orders.
        const nativeView = createOrthogonalFanoutView([1, 0, 0, 1])
        const nativeParams = nativeView.toCanonical({
          ...params,
          staticClearanceCache: undefined,
          bus,
          targetLayer,
          terminals: terminalsFor(),
          acceptedPlans: accepted,
          sourcePlans,
        })
        result = yield* winding(
          routeExtendedBridgeSteps({
            ...nativeParams,
            maximumDirectOrders: 6,
            maximumSearches: 384,
          }),
        )
        if (result) resultView = nativeView
      }
      if (!result)
        result = yield* winding(
          routeShortBridgeSteps({
            ...transformed,
            maximumSearches: getCornerBandSide(bus.exitEdge!, bus.preferredExit)
              ? undefined
              : 64,
          }),
        )
      if (result) {
        routed = restorePlans(resultView, result.plans)
        method = "declared-layer-bridge"
      }
    }
    if (!routed && wide) {
      const matrix: OrthogonalMatrix =
        bus.exitEdge === "bottom"
          ? [0, -1, 1, 0]
          : bus.exitEdge === "top"
            ? [0, 1, -1, 0]
            : bus.exitEdge === "left"
              ? [-1, 0, 0, 1]
              : [1, 0, 0, 1]
      const view = createOrthogonalFanoutView(matrix)
      const transformed = view.toCanonical({
        ...params,
        staticClearanceCache: undefined,
        bus,
        targetLayer,
        acceptedPlans: foreign,
        fixedViaPointsByConnectionIndex,
        sourceEscapePaths,
        reservedVias,
      })
      for (const routeCrossbar of [
        routeBottomCrossbarBusSteps,
        routeLeftCrossbarBusSteps,
        routeAdaptiveLeftCrossbarBusSteps,
        routeOppositeBottomCrossbarBusSteps,
      ]) {
        const result = yield* winding(routeCrossbar(transformed))
        if (!result) continue
        const candidate = restorePlans(view, result)
        if (
          !fanoutPlansAreClear({
            ...params,
            plans: mergeSources([...accepted, ...candidate]),
            sharedBoundary,
          })
        )
          continue
        routed = candidate
        method = "canonical-edge-crossbar"
        break
      }
    }
    // A different outside rail orientation can keep additional through-vias
    // clear of already accepted buses. Preserve the first canonical attempt,
    // then bound the alternatives by the four orthogonal edge views and a
    // small number of component-pitch offsets in the opposite crossbar.
    if (!routed && wide) {
      const views: readonly OrthogonalMatrix[] =
        bus.exitEdge === "bottom"
          ? [
              [0, -1, -1, 0],
              [0, 1, -1, 0],
              [0, 1, 1, 0],
            ]
          : bus.exitEdge === "top"
            ? [
                [0, 1, 1, 0],
                [0, -1, 1, 0],
                [0, -1, -1, 0],
              ]
            : bus.exitEdge === "left"
              ? [
                  [-1, 0, 0, -1],
                  [1, 0, 0, -1],
                  [1, 0, 0, 1],
                ]
              : [
                  [1, 0, 0, -1],
                  [-1, 0, 0, -1],
                  [-1, 0, 0, 1],
                ]
      for (const matrix of views) {
        const view = createOrthogonalFanoutView(matrix)
        const transformed = view.toCanonical({
          ...params,
          staticClearanceCache: undefined,
          bus,
          targetLayer,
          acceptedPlans: foreign,
          fixedViaPointsByConnectionIndex,
          sourceEscapePaths,
          reservedVias,
        })
        const candidates = [
          routeBottomCrossbarBusSteps(transformed),
          routeLeftCrossbarBusSteps(transformed),
          routeAdaptiveLeftCrossbarBusSteps(transformed),
          routeOppositeBottomCrossbarBusSteps(transformed),
        ]
        const pitchX = transformed.bus.pitchX
        const pitchY = transformed.bus.pitchY
        if (
          transformed.bus.exitEdge === "left" &&
          pitchX !== undefined &&
          pitchY !== undefined &&
          Number.isFinite(pitchX) &&
          Number.isFinite(pitchY) &&
          pitchX > 0 &&
          pitchY > 0
        ) {
          for (const sourcePitchOffset of [0, 1, 2, -1, -2]) {
            for (const rowPitchOffset of [0, 1]) {
              candidates.push(
                routeBottomCrossbarBusSteps({
                  ...transformed,
                  oppositeLayout: {
                    sourcePortOffset: sourcePitchOffset * pitchX,
                    rowOffset: rowPitchOffset * pitchY,
                    compactRows: true,
                  },
                }),
              )
            }
          }
        }
        for (const generator of candidates) {
          const result = yield* winding(generator)
          if (!result) continue
          const candidate = restorePlans(view, result)
          if (
            !fanoutPlansAreClear({
              ...params,
              plans: mergeSources([...accepted, ...candidate]),
              sharedBoundary,
            })
          )
            continue
          routed = candidate
          method = "mirrored-edge-crossbar"
          break
        }
        if (routed) break
      }
    }
    const hasDeclaredCrossover = allowed.some(
      (layer) => layer !== targetLayer && layer !== sourceLayer,
    )
    // A plain-edge declaration permits either ordered half-band. Choose tracks
    // with temporary guidance while preserving the original bus and connections.
    if (
      !routed &&
      wide &&
      hasDeclaredCrossover &&
      !getCornerBandSide(bus.exitEdge!, bus.preferredExit)
    ) {
      const preferredExits: PreparedBus["preferredExit"][] =
        bus.exitEdge === "bottom"
          ? ["bottom-left", "bottom-right"]
          : bus.exitEdge === "top"
            ? ["top-left", "top-right"]
            : bus.exitEdge === "left"
              ? ["bottom-left", "top-left"]
              : ["bottom-right", "top-right"]
      const matrix: OrthogonalMatrix =
        bus.exitEdge === "bottom"
          ? [0, 1, -1, 0]
          : bus.exitEdge === "top"
            ? [0, -1, 1, 0]
            : bus.exitEdge === "right"
              ? [-1, 0, 0, 1]
              : [1, 0, 0, 1]
      for (const preferredExit of preferredExits) {
        const view = createOrthogonalFanoutView(matrix)
        const transformed = view.toCanonical({
          ...params,
          staticClearanceCache: undefined,
          bus,
          targetLayer,
          acceptedPlans: accepted,
          sourcePlans,
          terminals: terminalsFor(0, { ...bus, preferredExit }),
        })
        const result = yield* winding(routeShortBridgeSteps(transformed))
        if (!result) continue
        const candidate = restorePlans(view, result.plans)
        if (
          !fanoutPlansAreClear({
            ...params,
            plans: mergeSources([...accepted, ...candidate]),
            sharedBoundary,
          })
        )
          continue
        routed = candidate
        method = "plain-edge-half-band-bridge"
        break
      }
    }
    // If neither legal half-band completes, preserve the original broad
    // plain-edge search after its cheaper preflight and track alternatives.
    if (
      !routed &&
      wide &&
      hasDeclaredCrossover &&
      !getCornerBandSide(bus.exitEdge!, bus.preferredExit)
    ) {
      const matrix: OrthogonalMatrix =
        bus.exitEdge === "bottom"
          ? [0, 1, -1, 0]
          : bus.exitEdge === "top"
            ? [0, -1, 1, 0]
            : bus.exitEdge === "right"
              ? [-1, 0, 0, 1]
              : [1, 0, 0, 1]
      const view = createOrthogonalFanoutView(matrix)
      const transformed = view.toCanonical({
        ...params,
        staticClearanceCache: undefined,
        bus,
        targetLayer,
        acceptedPlans: accepted,
        sourcePlans,
        terminals: terminalsFor(),
      })
      const result = yield* winding(routeShortBridgeSteps(transformed))
      if (result) {
        routed = restorePlans(view, result.plans)
        method = "declared-layer-bridge"
      }
    }
    function* tryExtendedBridge(): Generator<
      RouteBusAlternativesProgress,
      void,
      void
    > {
      for (const matrix of [
        [0, 1, -1, 0],
        [1, 0, 0, 1],
        [0, -1, 1, 0],
        [-1, 0, 0, 1],
      ] as const) {
        const view = createOrthogonalFanoutView(matrix)
        const transformed = view.toCanonical({
          ...params,
          staticClearanceCache: undefined,
          bus,
          targetLayer,
          terminals: terminalsFor(),
          acceptedPlans: accepted,
          sourcePlans,
        })
        const result = yield* winding(routeExtendedBridgeSteps(transformed))
        if (!result) continue
        routed = restorePlans(view, result.plans)
        method = "extended-declared-layer-bridge"
        break
      }
    }
    if (!routed && wide && hasDeclaredCrossover) yield* tryExtendedBridge()
    if (
      !routed &&
      bus.termination.type === "boundary" &&
      group.every((candidate) => candidate.connections.length <= 2)
    ) {
      routed = yield* routeNarrowWindingPreflightSteps({
        ...params,
        buses: group,
        targetLayer,
        acceptedPlans: foreign,
        sourcePlans,
        fixedViaPointsByConnectionIndex,
        sourceEscapePaths,
        reservedVias,
      })
      method = "narrow-winding-preflight"
    }
    if (!routed) {
      const ordinary = yield* routeReservedSourceBusesSteps({
        ...params,
        buses: group,
        sourceEscapes: params.sourceEscapes,
        sourceBoundary: params.sourceBoundary,
        initialPlans: foreign,
        fixedViaPointsByConnectionIndex,
        sourceEscapePaths,
        reservedVias,
      })
      routed = ordinary?.filter((plan) => own.has(plan.connectionIndex)) ?? null
      method = "ordinary"
    }
    if (
      !routed &&
      wide &&
      !hasDeclaredCrossover &&
      allowed.some((layer) => layer !== targetLayer)
    )
      yield* tryExtendedBridge()
    if (
      !routed ||
      routed.length !== own.size ||
      (!reservedPlane &&
        !fanoutPlansAreClear({
          ...params,
          plans: mergeSources([...accepted, ...routed]),
          sharedBoundary,
        }))
    )
      return null
    accepted.push(...routed)
    for (const plan of routed) completed.add(plan.connectionIndex)
    params.onBusComplete?.(bus, routed, method)
  }
  return accepted
}
