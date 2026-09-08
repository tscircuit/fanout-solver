import { getMultiEdgeBusTargets } from "./get-multi-edge-bus-targets"
import { matchBusPlanLengths } from "./match-bus-lengths"
import { mergeLayeredBoundaryTargets } from "./merge-layered-boundary-targets"
import { normalizeFanoutPlanCorners } from "./normalize-fanout-plan-corners"
import { preparePeripheralSourceReservations } from "./prepare-peripheral-source-reservations"
import { repairPairLengthsWithSourceTransitSteps } from "./repair-pair-lengths-with-source-transit"
import { rerouteSourceOriginLengthsSteps } from "./reroute-source-origin-lengths"
import type {
  LayerReservedBusesParams,
  LayerReservedRoutingProgress,
} from "./route-layer-reserved-buses"
import { routeReservedViaBusesSteps } from "./route-reserved-via-buses"
import { shortcutFanoutPlans } from "./shortcut-fanout-plans"
import type { FanoutRoutePlan } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

/** Route a four-sided lead package as one transaction across its permitted signal layers. */
export function* routePeripheralBusesSteps(
  params: LayerReservedBusesParams & { allowBlindAndBuriedVias?: boolean },
): Generator<LayerReservedRoutingProgress, FanoutRoutePlan[] | null> {
  const { srj, buses, layerNames } = params
  yield { phase: "sources", routedConnectionCount: 0 }
  const sources = preparePeripheralSourceReservations(params)
  if (!sources) return null
  const boundaries = buses.filter((bus) => bus.termination.type === "boundary")
  if (!boundaries.length || boundaries.some((bus) => !bus.exitEdge)) return null
  const targets = getMultiEdgeBusTargets(params)
  if (!targets) return null
  const exits = mergeLayeredBoundaryTargets({ buses, exits: targets.exits })
  const targetLayers = new Set(
    boundaries.map((bus) => targets.targetLayerByBusId.get(bus.busId)!),
  )
  const targetLayer = layerNames.findLast((layer) => targetLayers.has(layer))!
  const transitLayers = layerNames.filter(
    (layer) =>
      layer !== targetLayer &&
      boundaries.some((bus) =>
        (bus.routableEscapeLayers ?? bus.allowedLayers ?? layerNames).includes(
          layer,
        ),
      ),
  )
  const planes = sources.sourcePlans.filter(
    (plan) => plan.termination.type === "plane",
  )
  const routing = routeReservedViaBusesSteps({
    ...params,
    allBuses: buses,
    buses: boundaries,
    targetLayer,
    targetLayerByBusId: targets.targetLayerByBusId,
    transitLayers,
    terminals: boundaries.flatMap((bus) =>
      bus.connections.map((connection) => ({
        connection,
        viaPoint: sources.fixedViaPointsByConnectionIndex.get(
          connection.connectionIndex,
        )!,
        exitPoint: exits.get(connection.connectionIndex)!,
      })),
    ),
    ...sources,
    acceptedPlans: planes,
    routeFromSourcePads: true,
    sourceLayerTravelCost: 2,
    sourceOriginPhysicalGridPhase: true,
    includeDiagonalNeighbors: true,
    traceMarginExtra: 0,
    maximumIterations: 60_000_000,
    maximumRipEvents: 1000,
    maximumLocalRepairAttempts: 0,
    ripCost: 64,
    shuffleSeed: 1,
  })
  let step = routing.next()
  while (!step.done) {
    yield {
      phase: "route-layer",
      iterations: step.value.iterations,
      routedConnectionCount: planes.length + step.value.routedConnectionCount,
    }
    step = routing.next()
  }
  if (!step.value) return null
  let plans = [...step.value, ...planes]
  yield { phase: "repair-lengths", routedConnectionCount: plans.length }
  const shortened = shortcutFanoutPlans({
    ...params,
    inputSrj: srj,
    plans,
    preparedBuses: buses,
  })
  if (!shortened) return null
  plans = shortened
  for (const bus of boundaries) {
    if (bus.maxLengthSkew === undefined) continue
    const repair = rerouteSourceOriginLengthsSteps({
      ...params,
      inputSrj: srj,
      plans,
      preparedBuses: buses,
      bus,
    })
    let repaired = repair.next()
    while (!repaired.done) {
      yield {
        phase: "repair-lengths",
        iterations: repaired.value.iterations,
        routedConnectionCount: plans.length,
      }
      repaired = repair.next()
    }
    if (repaired.value) plans = repaired.value
  }
  yield { phase: "match-layer", routedConnectionCount: plans.length }
  let privatePlans = plans
  const matchingParams = {
    ...params,
    inputSrj: srj,
    plans,
    preparedBuses: buses,
    sharedBoundary: boundaries[0]!.sharedBoundary,
    maximumWorkUnits: 1000,
    allowSourcePrefixMatching: true,
    candidatePlansAreFeasible: (candidate: readonly FanoutRoutePlan[]) => {
      privatePlans = [...candidate]
      return true
    },
  }
  let matching = matchBusPlanLengths(matchingParams)
  if (!matching.plans) {
    matching = matchBusPlanLengths({
      ...matchingParams,
      maximumWorkUnits: 100_000,
      allowDistributedMatching: true,
      allowTransitLayerMatching: true,
      allowMatchingInsideDenseBounds: true,
    })
  }
  const attemptedPairs = new Set<string>()
  while (!matching.plans) {
    const failedBusId = matching.failedBus.busId
    const bus = boundaries.find((bus) => bus.busId === failedBusId)
    if (
      !bus ||
      bus.connections.length !== 2 ||
      bus.maxLengthSkew === undefined ||
      attemptedPairs.has(bus.busId)
    )
      return null
    attemptedPairs.add(bus.busId)
    const repair = repairPairLengthsWithSourceTransitSteps({
      ...params,
      inputSrj: srj,
      plans: privatePlans,
      preparedBuses: buses,
      bus,
    })
    let step = repair.next()
    while (!step.done) {
      yield {
        phase: "repair-lengths",
        iterations: step.value.iterations,
        routedConnectionCount: plans.length,
      }
      step = repair.next()
    }
    if (!step.value) return null
    privatePlans = step.value
    matching = matchBusPlanLengths({
      ...matchingParams,
      plans: privatePlans,
      maximumWorkUnits: 100_000,
      allowDistributedMatching: true,
      allowTransitLayerMatching: true,
      allowMatchingInsideDenseBounds: true,
    })
  }
  if (!matching.plans) return null
  const normalized = normalizeFanoutPlanCorners({
    ...params,
    inputSrj: srj,
    plans: matching.plans,
    preparedBuses: buses,
  })
  if (
    !normalized ||
    normalized.length !== srj.connections.length ||
    new Set(normalized.map((plan) => plan.connectionIndex)).size !==
      normalized.length
  )
    return null
  return validateRoutedCopperDrc({
    inputSrj: srj,
    routedSrj: {
      ...srj,
      traces: [
        ...(srj.traces ?? []),
        ...normalized.flatMap((plan) => [
          plan.trace,
          ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance: params.clearance,
    allowBlindAndBuriedVias: false,
  }).valid
    ? normalized
    : null
}
