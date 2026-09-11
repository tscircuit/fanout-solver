import { distance } from "./geometry"
import { getFanoutPlanSkew } from "./get-fanout-plan-effective-length"
import { matchBusPlanLengths } from "./match-bus-lengths"
import { preparePeripheralSourceReservations } from "./prepare-peripheral-source-reservations"
import type { RerouteSourceOriginLengthsParams } from "./reroute-source-origin-lengths"
import {
  type ReservedViaBusesProgress,
  routeReservedViaBusesSteps,
} from "./route-reserved-via-buses"
import type { FanoutRoutePlan, Point2D } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

/** Reconsider one failed pair's source vias and permitted transit layer atomically. */
export function* repairPairLengthsWithSourceTransitSteps(
  params: RerouteSourceOriginLengthsParams,
): Generator<ReservedViaBusesProgress, FanoutRoutePlan[] | null> {
  const { plans, bus, preparedBuses, inputSrj, layerNames } = params
  if (
    bus.termination.type !== "boundary" ||
    bus.connections.length !== 2 ||
    bus.maxLengthSkew === undefined ||
    bus.connections.some((c) => c.sourceLayer !== "top")
  )
    return null
  const connections = preparedBuses.flatMap((b) => b.connections)
  const byIndex = new Map(plans.map((p) => [p.connectionIndex, p]))
  if (
    connections.length !== inputSrj.connections.length ||
    byIndex.size !== connections.length ||
    plans.length !== byIndex.size ||
    connections.some(
      (c) =>
        byIndex.get(c.connectionIndex)?.connectionName !== c.connection.name,
    )
  )
    throw new Error(
      "FanoutSolver: transit pair repair requires every original plan",
    )
  const own = bus.connections.map((c) => byIndex.get(c.connectionIndex)!)
  const targetLayer = own[0]!.targetLayer
  if (
    own.some((p) => p.targetLayer !== targetLayer) ||
    getFanoutPlanSkew(own) <= bus.maxLengthSkew + 1e-6
  )
    return null
  const transitLayers = (
    bus.routableEscapeLayers ??
    bus.allowedLayers ??
    layerNames
  ).filter((layer) => layer !== "top" && layer !== targetLayer)
  if (!transitLayers.length) return null
  const fixed = new Map<number, Point2D>(),
    paths = new Map<number, readonly Point2D[]>()
  for (const connection of connections) {
    const plan = byIndex.get(connection.connectionIndex)!
    if (!plan.via) return null
    const source = plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1)
    if (
      !source.length ||
      source.some((s) => s.layer !== connection.sourceLayer) ||
      distance(source[0]!.start, connection.sourcePoint) > 1e-6 ||
      distance(source.at(-1)!.end, plan.via.center) > 1e-6 ||
      source.some(
        (s, i) => i > 0 && distance(source[i - 1]!.end, s.start) > 1e-6,
      )
    )
      return null
    fixed.set(connection.connectionIndex, plan.via.center)
    paths.set(connection.connectionIndex, [
      connection.sourcePoint,
      ...source.map((s) => s.end),
    ])
  }
  const selected = new Set(bus.connections.map((c) => c.connectionIndex))
  const startLayers = (
    bus.routableEscapeLayers ??
    bus.allowedLayers ??
    layerNames
  ).filter((layer) => layer !== "top")
  let remainingIterations = 5_000_000
  let peripheralSources:
    | ReturnType<typeof preparePeripheralSourceReservations>
    | undefined
  for (const startLayer of [undefined, ...startLayers]) {
    if (remainingIterations <= 0) break
    const sites = new Map(fixed),
      sourcePaths = new Map(paths)
    if (startLayer !== undefined) {
      peripheralSources ??= preparePeripheralSourceReservations({
        ...params,
        srj: inputSrj,
        buses: preparedBuses,
        side: "inward",
      })
      if (!peripheralSources) break
      for (const index of selected) {
        sites.set(
          index,
          peripheralSources.fixedViaPointsByConnectionIndex.get(index)!,
        )
        sourcePaths.set(index, peripheralSources.sourceEscapePaths.get(index)!)
      }
    }
    const routing = routeReservedViaBusesSteps({
      ...params,
      srj: inputSrj,
      allBuses: preparedBuses,
      buses: [bus],
      targetLayer,
      startLayerByBusId:
        startLayer === undefined
          ? undefined
          : new Map([[bus.busId, startLayer]]),
      transitLayers,
      terminals: bus.connections.map((connection) => ({
        connection,
        viaPoint: sites.get(connection.connectionIndex)!,
        exitPoint: byIndex.get(connection.connectionIndex)!.exitPoint,
      })),
      fixedViaPointsByConnectionIndex: sites,
      sourceEscapePaths: sourcePaths,
      acceptedPlans: plans.filter((p) => !selected.has(p.connectionIndex)),
      routeFromSourcePads: startLayer === undefined,
      sourceLayerTravelCost: 1,
      sourceOriginPhysicalGridPhase: true,
      tightViaChannels: true,
      includeDiagonalNeighbors: true,
      traceMarginExtra: 0,
      maximumIterations: Math.min(
        remainingIterations,
        startLayer === undefined ? 5_000_000 : 2_000_000,
      ),
      maximumRipEvents: 80,
      maximumLocalRepairAttempts: 0,
      ripCost: 256,
      shuffleSeed: 1,
    })
    let step = routing.next(),
      iterations = 0
    while (!step.done) {
      iterations = step.value.iterations
      yield step.value
      step = routing.next()
    }
    remainingIterations -= iterations
    const routed = step.value
    if (!routed || routed.length !== 2) continue
    const replacements = new Map(routed.map((p) => [p.connectionIndex, p]))
    const candidate = plans.map((p) => replacements.get(p.connectionIndex) ?? p)
    const matched = matchBusPlanLengths({
      ...params,
      plans: candidate,
      preparedBuses: [bus],
      sharedBoundary: bus.sharedBoundary,
      maximumWorkUnits: 100_000,
      allowSourcePrefixMatching: true,
      allowDistributedMatching: true,
      allowTransitLayerMatching: true,
      allowMatchingInsideDenseBounds: true,
    })
    if (
      !matched.plans ||
      matched.plans.some(
        (p) =>
          !selected.has(p.connectionIndex) &&
          p !== byIndex.get(p.connectionIndex),
      )
    )
      continue
    const changed = matched.plans.filter((p) => selected.has(p.connectionIndex))
    if (
      changed.length !== 2 ||
      getFanoutPlanSkew(changed) > bus.maxLengthSkew + 1e-6
    )
      continue
    if (
      validateRoutedCopperDrc({
        inputSrj,
        routedSrj: {
          ...inputSrj,
          traces: [
            ...(inputSrj.traces ?? []),
            ...matched.plans.flatMap((p) => [
              p.trace,
              ...(p.planeEndpointTrace ? [p.planeEndpointTrace] : []),
            ]),
          ],
        },
        clearance: params.clearance,
        allowBlindAndBuriedVias: false,
      }).valid
    )
      return matched.plans
  }
  return null
}
