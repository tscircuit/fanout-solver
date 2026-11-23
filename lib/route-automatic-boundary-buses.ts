import { getBoundaryTargetTrack } from "./route-bus/boundary-tracks"
import {
  getDirectionForExitEdge,
  getExitEdgeForDirection,
} from "./boundary-exit"
import { getDeclaredDifferentialPairs } from "./get-declared-differential-pairs"
import { packBoundaryBusIntervals } from "./pack-boundary-bus-intervals"
import { routeBus, type RouteBusParams } from "./route-bus"
import { getPlanVias } from "./route-bus/plan-copper"
import { routeLocalAutomaticSourcesSteps } from "./route-local-automatic-sources"
import {
  routeReservedViaBusesSteps,
  type ReservedViaBusesYield,
} from "./route-reserved-via-buses"
import type { FanoutRoutePlan, PreparedBus } from "./types"

type Params = Omit<RouteBusParams, "bus" | "targetLayer" | "acceptedPlans"> & {
  buses: readonly PreparedBus[]
  escapeLayers: readonly string[]
  initialPlans?: readonly FanoutRoutePlan[]
}
type Progress =
  | ReservedViaBusesYield
  | { routedConnectionCount: number; connectionCount: number }

/** Only unconfigured automatic BGA handoffs enter this recovery stage. */
export function isAutomaticBoundaryRoutingCandidate(
  params: Pick<Params, "srj" | "buses" | "allowBlindAndBuriedVias">,
): boolean {
  const { buses } = params
  if (
    params.allowBlindAndBuriedVias ||
    buses.length === 0 ||
    buses[0]!.componentObstacles.length < 64 ||
    getDeclaredDifferentialPairs(params.srj).length > 0 ||
    buses.some(
      (bus) =>
        bus.termination.type !== "boundary" ||
        bus.exitEdge ||
        bus.requestedDirection ||
        bus.preferredExit ||
        bus.maxLengthSkew !== undefined ||
        bus.componentId !== buses[0]!.componentId ||
        bus.connections.some((c) => c.sourceLayer !== "top"),
    )
  )
    return false
  return true
}

/** Automatic boundaries are handoffs, not fixed downstream destinations.
 * Use the existing joint source router for competing intact buses, then the
 * existing bus router for the remaining sources. Every displacement restores
 * its complete bus before committing; original pads and rules stay hard. */
export function* routeAutomaticBoundaryBusesSteps(
  params: Params,
): Generator<Progress, FanoutRoutePlan[] | null, unknown> {
  const { buses } = params
  const wide = buses.filter((bus) => bus.connections.length > 1)
  if (!isAutomaticBoundaryRoutingCandidate(params)) return null
  const traceWidth = wide[0]?.traceWidth ?? params.traceWidth
  const layers = params.escapeLayers.filter((layer) => layer !== "top")
  if (layers.length < 2) return null
  const sourceBuses = wide.map((bus) => ({
    ...bus,
    exitEdge: getExitEdgeForDirection(bus.direction),
  }))
  const packingBuses = sourceBuses.map((bus) => ({
    ...bus,
    sharedBoundary: {
      minX: bus.sharedBoundary.minX + traceWidth,
      maxX: bus.sharedBoundary.maxX - traceWidth,
      minY: bus.sharedBoundary.minY + traceWidth,
      maxY: bus.sharedBoundary.maxY - traceWidth,
    },
  }))
  const count = buses.reduce((sum, bus) => sum + bus.connections.length, 0)
  const distanceToEdge = (bus: PreparedBus) =>
    Math.max(
      ...bus.connections.map((connection) => {
        const point = connection.sourcePoint,
          bounds = bus.sharedBoundary
        return Math.min(
          point.x - bounds.minX,
          bounds.maxX - point.x,
          point.y - bounds.minY,
          bounds.maxY - point.y,
        )
      }),
    )
  // Interior sources need their escape corridors before the outer pad rows.
  const routingOrder =
    wide.length < 2
      ? [...buses].sort(
          (a, b) =>
            b.connections.length - a.connections.length ||
            distanceToEdge(b) - distanceToEdge(a),
        )
      : buses
  const jointCount = wide.reduce((sum, bus) => sum + bus.connections.length, 0)
  const byId = new Map(buses.map((bus) => [bus.busId, bus]))
  const layersFor = (bus: PreparedBus) =>
    (
      bus.routableEscapeLayers ??
      bus.allowedLayers ??
      params.escapeLayers
    ).filter((layer) =>
      (bus.allowedLayers ?? params.layerNames).includes(layer),
    )
  const tryRoute = (
    bus: PreparedBus,
    acceptedPlans: FanoutRoutePlan[],
    blockingBusCounts?: Map<string, number>,
  ) => {
    for (const targetLayer of layersFor(bus)) {
      for (const direction of [
        bus.direction,
        ...(["left", "right", "up", "down"] as const).filter(
          (direction) => direction !== bus.direction,
        ),
      ]) {
        const plans = routeBus({
          ...params,
          bus: { ...bus, direction },
          targetLayer,
          acceptedPlans,
          blockingBusCounts,
          preferSourceTracks: true,
          allowAutomaticSourceBoundaryRecovery: true,
        })
        if (plans) return plans
      }
    }
    return null
  }
  const complete = function* (
    initial: readonly FanoutRoutePlan[],
  ): Generator<Progress, FanoutRoutePlan[] | null, unknown> {
    let plans = [...initial]
    let improved = true
    while (improved && plans.length < count) {
      improved = false
      for (const bus of routingOrder) {
        if (plans.some((plan) => plan.busId === bus.busId)) continue
        const blocking = new Map<string, number>()
        const direct = tryRoute(bus, plans, blocking)
        if (direct) {
          plans.push(...direct)
          improved = true
          yield {
            routedConnectionCount: plans.length,
            connectionCount: count,
          }
          continue
        }
        const source = bus.connections[0]!.sourcePoint
        const localOwners = plans
          .filter((plan) =>
            getPlanVias(plan).some(
              (via) =>
                Math.hypot(via.center.x - source.x, via.center.y - source.y) <=
                Math.max(bus.pitchX, bus.pitchY) + 1e-9,
            ),
          )
          .map((plan) => plan.busId)
        const blockers = [
          ...new Set([
            ...localOwners,
            ...[...blocking]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 16)
              .map(([id]) => id),
          ]),
        ]
        const localCohorts: PreparedBus[][] = []
        for (const blockerId of blockers) {
          const displaced = byId.get(blockerId)!
          const kept = plans.filter((plan) => plan.busId !== blockerId)
          const added = tryRoute(bus, kept)
          if (!added) continue
          const restoreBlocking = new Map<string, number>()
          const restored = tryRoute(
            displaced,
            [...kept, ...added],
            restoreBlocking,
          )
          if (!restored) {
            if (
              bus.connections.length !== 1 ||
              displaced.connections.length !== 1
            )
              continue
            const origin = displaced.connections[0]!.sourcePoint
            const nearby = kept
              .filter((plan) =>
                getPlanVias(plan).some(
                  (via) =>
                    Math.hypot(
                      via.center.x - origin.x,
                      via.center.y - origin.y,
                    ) <=
                    Math.max(displaced.pitchX, displaced.pitchY) + 1e-9,
                ),
              )
              .map((plan) => plan.busId)
            const candidates = [
              ...new Set([
                ...nearby,
                ...[...restoreBlocking]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 4)
                  .map(([id]) => id),
              ]),
            ]
            for (const secondId of candidates) {
              const second = byId.get(secondId)
              if (
                !second ||
                second.connections.length !== 1 ||
                secondId === bus.busId ||
                secondId === displaced.busId
              )
                continue
              localCohorts.push([bus, displaced, second])
            }
            continue
          }
          plans = [...kept, ...added, ...restored]
          improved = true
          break
        }
        if (
          !plans.some((plan) => plan.busId === bus.busId) &&
          count - plans.length <= 4
        ) {
          for (const cohort of localCohorts.slice(0, 12)) {
            const repaired = yield* routeLocalAutomaticSourcesSteps({
              ...params,
              buses: cohort,
              plans,
            })
            if (!repaired) continue
            plans = repaired
            improved = true
            break
          }
        }
        yield { routedConnectionCount: plans.length, connectionCount: count }
      }
    }
    if (plans.length === count) return plans
    return null
  }
  if (params.initialPlans) return yield* complete(params.initialPlans)
  if (wide.length < 2) {
    const completed = yield* complete([])
    if (completed) return completed
    return null
  }
  if (
    wide.length === 0 ||
    wide.some(
      (bus) =>
        bus.connections.length > 8 ||
        (bus.traceWidth ?? params.traceWidth) !== traceWidth,
    )
  )
    return null
  for (let rotation = 0; rotation < layers.length; rotation++) {
    const targetLayerByBusId = new Map(
      sourceBuses.map((bus, index) => [
        bus.busId,
        layers[(rotation + index) % layers.length]!,
      ]),
    )
    if (
      sourceBuses.some(
        (bus) => !layersFor(bus).includes(targetLayerByBusId.get(bus.busId)!),
      )
    )
      continue
    // Automatic downstream hints may overlap. This fixed-track seed cannot
    // preserve them; leave those inputs to the ordinary unconstrained strategy.
    if (
      packingBuses.some((bus) => {
        const desired = bus.connections
          .map((connection) =>
            getBoundaryTargetTrack({
              ...params,
              bus,
              connection,
              targetLayer: targetLayerByBusId.get(bus.busId)!,
              boundaryDirection: getDirectionForExitEdge(bus.exitEdge!),
            }),
          )
          .toSorted((a, b) => a - b)
        return desired.some(
          (track, index) =>
            index > 0 &&
            track - desired[index - 1]! < traceWidth + params.clearance - 1e-8,
        )
      })
    )
      continue
    const packed = packBoundaryBusIntervals({
      ...params,
      traceWidth,
      buses: packingBuses,
      targetLayerByBusId,
    })
    const terminals = sourceBuses.flatMap((bus) =>
      bus.connections.map((connection) => {
        const track = packed.tracksByConnectionIndex.get(
            connection.connectionIndex,
          )!,
          b = bus.sharedBoundary
        const exitPoint =
          bus.exitEdge === "left"
            ? { x: b.minX, y: track }
            : bus.exitEdge === "right"
              ? { x: b.maxX, y: track }
              : bus.exitEdge === "top"
                ? { x: track, y: b.maxY }
                : { x: track, y: b.minY }
        return { connection, viaPoint: connection.sourcePoint, exitPoint }
      }),
    )
    for (let shuffleSeed = 1; shuffleSeed <= 3; shuffleSeed++) {
      const steps = routeReservedViaBusesSteps({
        ...params,
        traceWidth,
        allBuses: sourceBuses,
        buses: sourceBuses,
        targetLayer: targetLayerByBusId.get(sourceBuses[0]!.busId)!,
        targetLayerByBusId,
        terminals,
        fixedViaPointsByConnectionIndex: new Map(
          terminals.map((t) => [t.connection.connectionIndex, t.viaPoint]),
        ),
        acceptedPlans: [],
        routeFromSourcePads: true,
        transitLayers: layers,
        includeDiagonalNeighbors: true,
        terminalApproachLength: traceWidth + params.clearance,
        maximumIterations: jointCount * 240_000,
        maximumLocalRepairAttempts: 0,
        maximumSourceOriginRepairAttempts: 0,
        shuffleSeed,
      })
      let next = steps.next()
      while (!next.done) {
        const output = yield next.value
        next = steps.next(output)
      }
      if (!next.value) continue
      let plans: FanoutRoutePlan[] = next.value.map((plan) => ({
        ...plan,
        exitEdge: byId.get(plan.busId)!.exitEdge,
      }))
      const completed = yield* complete(plans)
      if (completed) return completed
    }
  }
  return null
}
