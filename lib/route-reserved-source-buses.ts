import { routeAdaptiveLeftCrossbarBusSteps } from "./route-adaptive-left-crossbar-bus"
import { routeOppositeBottomCrossbarBusSteps } from "./route-opposite-bottom-crossbar-bus"
import { reflectFanoutX } from "./reflect-fanout-x"
import { routeReservedNarrowBusesSteps } from "./route-reserved-narrow-buses"
import { routeBottomCrossbarBusSteps } from "./route-bottom-crossbar-bus"
import { routeLeftCrossbarBusSteps } from "./route-left-crossbar-bus"
import type { Bounds, FanoutRoutePlan, PreparedBus } from "./types"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import {
  fanoutPlansAreClear,
  routeBusAlternativesSteps,
  type RouteBusAlternativesProgress,
  type RouteBusParams,
} from "./route-bus"

export interface RouteReservedSourceBusesParams
  extends Omit<RouteBusParams, "bus" | "targetLayer" | "acceptedPlans"> {
  buses: readonly PreparedBus[]
  sourceEscapes: readonly PeripheralSourceEscape[]
  initialPlans: readonly FanoutRoutePlan[]
  targetLayerByBusId?: ReadonlyMap<string, string>
  sourceBoundary?: Bounds
}

/** Finish buses while preserving every already matched source escape and via. */
export function* routeReservedSourceBusesSteps(
  params: RouteReservedSourceBusesParams,
): Generator<RouteBusAlternativesProgress, FanoutRoutePlan[] | null, void> {
  if (
    params.buses.some((bus) => bus.termination.type === "boundary") &&
    params.buses.every(
      (bus) => bus.termination.type === "plane" || bus.exitEdge === "left",
    )
  ) {
    const mirrored = reflectFanoutX(params)
    const plans = yield* routeReservedSourceBusesSteps(mirrored)
    if (!plans) return null
    const restored = reflectFanoutX(plans)
    const originalConnections = new Map(
      params.buses.flatMap((bus) =>
        bus.connections.map(
          (connection) => [connection.connectionIndex, connection] as const,
        ),
      ),
    )
    return restored.map((plan) => ({
      ...plan,
      sourceObstacle: originalConnections.get(plan.connectionIndex)!
        .sourceObstacle,
    }))
  }
  const { buses, sourceEscapes, initialPlans } = params
  const byIndex = new Map(
    sourceEscapes.map((source) => [source.connectionIndex, source]),
  )
  const committedIndices = new Set(
    initialPlans.map((plan) => plan.connectionIndex),
  )
  const pending = buses.filter((bus) =>
    bus.connections.some(
      (connection) => !committedIndices.has(connection.connectionIndex),
    ),
  )
  if (
    pending.some((bus) =>
      bus.connections.some((connection) =>
        committedIndices.has(connection.connectionIndex),
      ),
    )
  ) {
    throw new Error(
      "FanoutSolver: a reserved-source continuation cannot start with a partially committed bus",
    )
  }
  for (const bus of pending)
    for (const connection of bus.connections) {
      if (!byIndex.has(connection.connectionIndex))
        throw new Error(
          `FanoutSolver: missing reserved source escape for ${connection.connection.name}`,
        )
    }
  const fixedViaPointsByConnectionIndex = new Map(
    sourceEscapes.map((source) => [source.connectionIndex, source.via.center]),
  )
  const sourceEscapePaths = new Map(
    sourceEscapes.map((source) => [
      source.connectionIndex,
      [
        source.segments[0]!.start,
        ...source.segments.map((segment) => segment.end),
      ],
    ]),
  )
  const accepted = [...initialPlans]
  const occupiedLayerCount = (bus: PreparedBus) => {
    const layer =
      params.targetLayerByBusId?.get(bus.busId) ??
      (bus.allowedLayers ?? params.layerNames).find(
        (layer) => layer !== bus.connections[0]!.sourceLayer,
      )
    return initialPlans.filter((plan) => plan.targetLayer === layer).length
  }
  const boundaryBuses = pending
    .filter((bus) => bus.termination.type === "boundary")
    .sort(
      (a, b) =>
        b.connections.length - a.connections.length ||
        occupiedLayerCount(a) - occupiedLayerCount(b),
    )
  const groupedNarrow = new Set<string>()
  for (const bus of [
    ...boundaryBuses,
    ...pending.filter((bus) => bus.termination.type === "plane"),
  ]) {
    if (groupedNarrow.has(bus.busId)) continue
    if (
      bus.termination.type === "boundary" &&
      bus.connections.length <= 2 &&
      params.targetLayerByBusId
    ) {
      const targetLayer = params.targetLayerByBusId.get(bus.busId)
      if (!targetLayer) return null
      const group = boundaryBuses.filter(
        (candidate) =>
          candidate.connections.length <= 2 &&
          params.targetLayerByBusId!.get(candidate.busId) === targetLayer,
      )
      const plans = yield* routeReservedNarrowBusesSteps({
        ...params,
        buses: group,
        targetLayer,
        acceptedPlans: accepted,
        fixedViaPointsByConnectionIndex,
        sourceEscapePaths,
        reservedVias: sourceEscapes.map((source) => ({
          connectionName: source.connectionName,
          via: source.via,
        })),
      })
      if (!plans) return null
      accepted.push(...plans)
      for (const candidate of group) groupedNarrow.add(candidate.busId)
      continue
    }
    const ownIndices = new Set(
      bus.connections.map((connection) => connection.connectionIndex),
    )
    const reservedVias = sourceEscapes
      .filter((source) => !ownIndices.has(source.connectionIndex))
      .map((source) => ({
        connectionName: source.connectionName,
        via: source.via,
        ...(source.segments.length === 1
          ? { sourceEscapeSegment: source.segments[0] }
          : {}),
      }))
    const assignedLayer = params.targetLayerByBusId?.get(bus.busId)
    const layers = assignedLayer
      ? [assignedLayer]
      : bus.termination.type === "plane"
        ? [bus.termination.layer]
        : (
            bus.routableEscapeLayers ??
            bus.allowedLayers ??
            params.layerNames
          ).filter((layer) => layer !== bus.connections[0]!.sourceLayer)
    let routed: FanoutRoutePlan[] | undefined
    for (const targetLayer of layers) {
      const routeParams = {
        ...params,
        bus,
        targetLayer,
        acceptedPlans: accepted,
        fixedViaPointsByConnectionIndex,
        sourceEscapePaths,
        reservedVias,
      }
      if (
        params.sourceBoundary &&
        bus.termination.type === "boundary" &&
        bus.connections.length > 2
      ) {
        for (const routeCrossbar of [
          routeBottomCrossbarBusSteps,
          routeLeftCrossbarBusSteps,
          routeAdaptiveLeftCrossbarBusSteps,
          routeOppositeBottomCrossbarBusSteps,
        ]) {
          const steps = routeCrossbar({
            ...routeParams,
            sourceBoundary: params.sourceBoundary,
          })
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
          if (step.value) {
            routed = step.value
            break
          }
        }
        if (routed) break
      }
      const alternatives = yield* routeBusAlternativesSteps(
        {
          ...params,
          bus,
          targetLayer,
          acceptedPlans: accepted,
          fixedViaPointsByConnectionIndex,
          sourceEscapePaths,
          reservedVias,
          viaMinimalOnly: true,
          adaptiveWindingRouteOrder: true,
          alignWindingGridToPads: true,
          windingGridStep: (params.traceWidth + params.clearance) / 2,
          fixedViaFallbackRouteOrderAttempts: 32,
        },
        1,
        false,
      )
      if (alternatives.length) {
        routed = alternatives[0]
        break
      }
    }
    if (!routed) return null
    accepted.push(...routed)
  }
  const sharedBoundary = buses[0]?.sharedBoundary
  if (
    !sharedBoundary ||
    !fanoutPlansAreClear({ ...params, plans: accepted, sharedBoundary })
  )
    return null
  return accepted
}
