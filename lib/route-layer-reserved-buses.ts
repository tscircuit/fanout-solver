import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { sourceTransitHasMajorityCrossings } from "./source-transit-crossing-pressure"
import { LayerRoutingAttempts } from "./layer-routing-attempts"
import { packBoundaryBusIntervals } from "./pack-boundary-bus-intervals"
import { getBoundaryBusSlotOffsets } from "./get-boundary-bus-slot-offsets"
import { routeLayerReservedSourceEscapesSteps } from "./route-layer-reserved-source-escapes"
import { routeReservedViaBusesSteps } from "./route-reserved-via-buses"
import { matchBusPlanLengths } from "./match-bus-lengths"
import { shortcutFanoutPlans } from "./shortcut-fanout-plans"
import { rerouteOverlongBusLanesSteps } from "./reroute-overlong-bus-lanes"
import { repairBusLengthsWithTransitSteps } from "./repair-bus-lengths-with-transit"
import { rerouteBusWithRetainedBoundaryTailsSteps } from "./reroute-bus-with-retained-boundary-tails"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"

export interface LayerReservedBusesParams {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
}

export interface LayerReservedRoutingProgress {
  phase: "sources" | "route-layer" | "match-layer" | "repair-lengths"
  layer?: string
  routedConnectionCount: number
  iterations?: number
}

export function getLayerReservedBusTargets(params: LayerReservedBusesParams) {
  const { buses, layerNames, traceWidth, clearance } = params
  const boundaries = buses.filter((b) => b.termination.type === "boundary")
  const constrainedLoad = new Map<string, number>()
  for (const bus of boundaries)
    if (bus.allowedLayers?.length === 1) {
      const layer = bus.allowedLayers[0]!
      constrainedLoad.set(
        layer,
        (constrainedLoad.get(layer) ?? 0) + bus.connections.length,
      )
    }
  const targetLayerByBusId = new Map<string, string>()
  for (const bus of buses) {
    const sourceLayers = new Set(bus.connections.map((c) => c.sourceLayer))
    const candidates = (
      bus.routableEscapeLayers ??
      bus.allowedLayers ??
      layerNames
    )
      .filter((layer) => !sourceLayers.has(layer))
      .toSorted(
        (a, b) =>
          (constrainedLoad.get(a) ?? 0) - (constrainedLoad.get(b) ?? 0) ||
          layerNames.indexOf(b) - layerNames.indexOf(a),
      )
    const layer =
      bus.termination.type === "plane" ? bus.termination.layer : candidates[0]
    if (!layer) return null
    targetLayerByBusId.set(bus.busId, layer)
  }
  const packed = packBoundaryBusIntervals({ ...params, targetLayerByBusId })
  const tracks = new Map(packed.tracksByConnectionIndex)
  const slots = getBoundaryBusSlotOffsets(buses)
  const axis = (bus: PreparedBus) =>
    bus.exitEdge === "left" || bus.exitEdge === "right" ? "y" : "x"
  const pitch = traceWidth + clearance
  for (const bus of boundaries) {
    if (bus.allowedLayers?.length !== 1) continue
    const tangent = axis(bus),
      bounds = bus.sharedBoundary
    const minimum = tangent === "y" ? bounds.minY : bounds.minX
    const maximum = tangent === "y" ? bounds.maxY : bounds.maxX
    const raw = bus.connections.map(
      (c) => (c.exitTargetPoint ?? c.targetPoint)[tangent],
    )
    const ordered = raw.toSorted((a, b) => a - b)
    if (
      ordered.some(
        (value, i) =>
          !Number.isFinite(value) ||
          (i > 0 && value - ordered[i - 1]! < pitch - 1e-8),
      )
    )
      continue
    const span = ordered.at(-1)! - ordered[0]!
    if (span > maximum - minimum) continue
    let proposed: number[]
    if (!slots.has(bus.busId)) {
      const shift = Math.max(
        minimum - ordered[0]!,
        Math.min(0, maximum - ordered.at(-1)!),
      )
      proposed = raw.map((value) => value + shift)
    } else if (bus.connections.length === 2) {
      const previous = bus.connections.map(
        (c) => tracks.get(c.connectionIndex)!,
      )
      const mean = (previous[0]! + previous[1]!) / 2
      const previousSpan = Math.abs(previous[1]! - previous[0]!)
      proposed = previous.map(
        (value) => mean + ((value - mean) * span) / previousSpan,
      )
    } else continue
    const own = new Set(bus.connections.map((c) => c.connectionIndex))
    const others = boundaries
      .filter(
        (b) =>
          b.exitEdge === bus.exitEdge &&
          targetLayerByBusId.get(b.busId) === targetLayerByBusId.get(bus.busId),
      )
      .flatMap((b) =>
        b.connections
          .filter((c) => !own.has(c.connectionIndex))
          .map((c) => tracks.get(c.connectionIndex)!),
      )
    if (
      proposed.some(
        (value) =>
          value < minimum ||
          value > maximum ||
          others.some((other) => Math.abs(value - other) < pitch - 1e-8),
      )
    )
      continue
    for (const [i, connection] of bus.connections.entries())
      tracks.set(connection.connectionIndex, proposed[i]!)
  }
  const exits = new Map<number, Point2D>()
  for (const bus of boundaries)
    for (const connection of bus.connections) {
      const track = tracks.get(connection.connectionIndex)!,
        bounds = bus.sharedBoundary
      const point =
        bus.exitEdge === "left"
          ? { x: bounds.minX, y: track }
          : bus.exitEdge === "right"
            ? { x: bounds.maxX, y: track }
            : bus.exitEdge === "top"
              ? { x: track, y: bounds.maxY }
              : { x: track, y: bounds.minY }
      exits.set(connection.connectionIndex, point)
    }
  return { targetLayerByBusId, exits }
}

/** Finish each target layer around a complete, shared set of source reservations. */
export function* routeLayerReservedBusesSteps(
  params: LayerReservedBusesParams,
): Generator<LayerReservedRoutingProgress, FanoutRoutePlan[] | null, unknown> {
  const { buses, srj, layerNames } = params
  const targets = getLayerReservedBusTargets(params)
  if (!targets) return null
  const sourceSteps = routeLayerReservedSourceEscapesSteps(params)
  let source = sourceSteps.next()
  while (!source.done) {
    yield { phase: "sources", routedConnectionCount: 0 }
    source = sourceSteps.next()
  }
  if (!source.value) return null
  const { fixedViaPointsByConnectionIndex, sourceEscapePaths, sourcePlans } =
    source.value
  let accepted: FanoutRoutePlan[] = []
  const completed = new Set(
    buses.filter((b) => b.termination.type === "plane").map((b) => b.busId),
  )
  const groups = new Map<string, PreparedBus[]>()
  for (const bus of buses)
    if (bus.termination.type === "boundary") {
      const layer = targets.targetLayerByBusId.get(bus.busId)!
      groups.set(layer, [...(groups.get(layer) ?? []), bus])
    }
  const ordered = [...groups].sort(
    ([, a], [, b]) =>
      Math.max(
        ...a.map((bus) => bus.allowedLayers?.length ?? layerNames.length),
      ) -
        Math.max(
          ...b.map((bus) => bus.allowedLayers?.length ?? layerNames.length),
        ) ||
      Math.max(...b.map((bus) => bus.connections.length)) -
        Math.max(...a.map((bus) => bus.connections.length)),
  )
  for (const [layer, group] of ordered) {
    const maximumBusSize = Math.max(
      ...group.map((bus) => bus.connections.length),
    )
    const shortenFirst =
      maximumBusSize > 2 &&
      group.every((bus) => bus.allowedLayers?.length === 1)
    const transitLayers = layerNames.filter(
      (candidate) =>
        candidate !== layer &&
        group.every(
          (bus) =>
            (
              bus.routableEscapeLayers ??
              bus.allowedLayers ??
              layerNames
            ).includes(candidate) &&
            bus.connections.every((c) => c.sourceLayer !== candidate),
        ),
    )
    const allTransitLayers = layerNames.filter(
      (candidate) =>
        candidate !== layer &&
        group.every((bus) =>
          (
            bus.routableEscapeLayers ??
            bus.allowedLayers ??
            layerNames
          ).includes(candidate),
        ),
    )
    const previousAccepted = accepted
    const attempts = new LayerRoutingAttempts({
      wideSingleLayer: shortenFirst,
      firstRipCost: maximumBusSize <= 2 ? 256 : 64,
      transitLayers,
      allTransitLayers,
      // If most direct escape corridors cross, a wide group on one layer
      // otherwise winds around itself. Prefer its permitted source transit.
      preferSourceTransit:
        maximumBusSize > 2 &&
        transitLayers.length === 0 &&
        allTransitLayers.length > 0 &&
        sourceTransitHasMajorityCrossings(
          group.flatMap((bus) =>
            bus.connections.map((connection) => ({
              source: fixedViaPointsByConnectionIndex.get(
                connection.connectionIndex,
              )!,
              target: targets.exits.get(connection.connectionIndex)!,
            })),
          ),
        ),
    })
    let groupCompleted = false
    for (let attempt = attempts.next(); attempt; attempt = attempts.next()) {
      // Every search and tuning attempt starts from the same committed set.
      // A complete topology does not reserve copper until its bus lengths pass.
      accepted = previousAccepted
      for (const bus of group) completed.delete(bus.busId)
      const hasTransitRetry =
        attempt.transitLayers.length < allTransitLayers.length
      const steps = routeReservedViaBusesSteps({
        ...params,
        allBuses: buses,
        buses: group,
        targetLayer: layer,
        transitLayers: attempt.transitLayers,
        fixedViaPointsByConnectionIndex,
        sourceEscapePaths,
        acceptedPlans: accepted,
        terminals: group.flatMap((bus) =>
          bus.connections.map((connection) => ({
            connection,
            viaPoint: fixedViaPointsByConnectionIndex.get(
              connection.connectionIndex,
            )!,
            exitPoint: targets.exits.get(connection.connectionIndex)!,
          })),
        ),
        tightViaChannels: true,
        ripCost: attempt.ripCost,
        maximumRipEvents: 400,
        maximumLocalRepairAttempts: hasTransitRetry ? 0 : 3,
        maximumIterations: 100_000_000,
        shuffleSeed: attempt.shuffleSeed,
      })
      let next = steps.next()
      while (!next.done) {
        yield {
          phase: "route-layer",
          layer,
          routedConnectionCount:
            accepted.length + next.value.routedConnectionCount,
          iterations: next.value.iterations,
        }
        next = steps.next()
      }
      const routedPlans = next.value
      if (!routedPlans) {
        attempts.failed(attempt, "routing")
        continue
      }
      accepted = [...accepted, ...routedPlans]
      for (const bus of group) completed.add(bus.busId)
      yield {
        phase: "match-layer",
        layer,
        routedConnectionCount: accepted.length,
      }
      const routed = new Set(accepted.map((plan) => plan.connectionIndex))
      let completePlans = [
        ...accepted,
        ...sourcePlans.filter((plan) => !routed.has(plan.connectionIndex)),
      ]
      const completedBuses = buses.filter((bus) => completed.has(bus.busId))
      completePlans =
        shortcutFanoutPlans({
          ...params,
          inputSrj: srj,
          plans: completePlans,
          preparedBuses: completedBuses,
          selectedBusIds: new Set(group.map((bus) => bus.busId)),
          allowBlindAndBuriedVias: false,
        }) ?? completePlans
      const matchCompletePlans = (maximumWorkUnits?: number) =>
        matchBusPlanLengths({
          ...params,
          inputSrj: srj,
          sharedBoundary: buses[0]!.sharedBoundary,
          plans: completePlans,
          preparedBuses: completedBuses,
          allowBlindAndBuriedVias: false,
          allowSameNetMerges: false,
          allowMatchingInsideDenseBounds: true,
          allowPairLaneSpreading: true,
          allowUnconstrainedLaneRerouting: true,
          maximumWorkUnits,
        })
      function* shortenCompletePlans(): Generator<
        LayerReservedRoutingProgress,
        void,
        unknown
      > {
        const shorteningSteps = rerouteOverlongBusLanesSteps({
          ...params,
          inputSrj: srj,
          plans: completePlans,
          preparedBuses: buses,
          selectedBusIds: new Set(group.map((bus) => bus.busId)),
        })
        let shortening = shorteningSteps.next()
        while (!shortening.done) {
          yield {
            phase: "repair-lengths",
            layer,
            routedConnectionCount: accepted.length,
          }
          shortening = shorteningSteps.next()
        }
        completePlans = shortening.value ?? completePlans
      }
      // A wide bus restricted to one layer cannot use transit to shorten a
      // detour. Remove avoidable winding before spending time on meanders.
      if (shortenFirst) yield* shortenCompletePlans()
      let matched = matchCompletePlans(shortenFirst ? undefined : 1_000)
      if (!matched.plans && !shortenFirst) {
        // Preserve directly tunable pairs and flexible buses; moving their
        // copper can occupy corridors needed by another layer group.
        yield* shortenCompletePlans()
        matched = matchCompletePlans(hasTransitRetry ? 1_000 : undefined)
      }
      if (matched.plans) {
        completePlans = matched.plans
      } else {
        if (hasTransitRetry) {
          attempts.failed(attempt, "lengths")
          continue
        }
        const repairSteps = repairBusLengthsWithTransitSteps({
          ...params,
          inputSrj: srj,
          plans: completePlans,
          preparedBuses: buses,
          busIds: group.map((bus) => bus.busId),
        })
        let repair = repairSteps.next()
        while (!repair.done) {
          yield {
            phase: "repair-lengths",
            layer,
            routedConnectionCount: accepted.length,
            iterations: repair.value.iterations,
          }
          repair = repairSteps.next()
        }
        if (repair.value) {
          completePlans = repair.value
        } else {
          // A valid near-boundary lead can be unreachable from a clipped grid
          // cell. Retain that lead while the intact bus seeks shorter paths.
          const tailSteps = rerouteBusWithRetainedBoundaryTailsSteps({
            ...params,
            inputSrj: srj,
            plans: completePlans,
            preparedBuses: buses,
            busIds: group.map((bus) => bus.busId),
          })
          let tails = tailSteps.next()
          while (!tails.done) {
            yield {
              phase: "repair-lengths",
              layer,
              routedConnectionCount: accepted.length,
              iterations: tails.value.iterations,
            }
            tails = tailSteps.next()
          }
          if (!tails.value) {
            attempts.failed(attempt, "lengths")
            continue
          }
          completePlans = tails.value
        }
      }
      accepted = completePlans.filter((plan) =>
        routed.has(plan.connectionIndex),
      )
      groupCompleted = true
      break
    }
    if (!groupCompleted) return null
  }
  return [
    ...accepted,
    ...sourcePlans.filter(
      (plan) => completed.has(plan.busId) && plan.termination.type === "plane",
    ),
  ]
}
