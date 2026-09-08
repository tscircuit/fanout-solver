import { getExitEdgeForDirection } from "./boundary-exit"
import { getBoundaryApproachReservations } from "./get-boundary-approach-reservations"
import { getMultiEdgeBusTargets } from "./get-multi-edge-bus-targets"
import { matchBusPlanLengths } from "./match-bus-lengths"
import { mergeLayeredBoundaryTargets } from "./merge-layered-boundary-targets"
import { normalizeFanoutPlanCorners } from "./normalize-fanout-plan-corners"
import { rerouteOverlongBusLanesSteps } from "./reroute-overlong-bus-lanes"
import { rerouteSourceOriginLengthsSteps } from "./reroute-source-origin-lengths"
import type {
  LayerReservedBusesParams,
  LayerReservedRoutingProgress,
} from "./route-layer-reserved-buses"
import { routeReservedViaBusesSteps } from "./route-reserved-via-buses"
import { prepareSourceOriginReservations } from "./route-source-origin-buses"
import { shortcutFanoutPlans } from "./shortcut-fanout-plans"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

const copperTraces = (plans: readonly FanoutRoutePlan[]) =>
  plans.flatMap((plan) => [
    plan.trace,
    ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
  ])

/** Route intact edge groups around one shared, validated source reservation.
 * Unfinished sources and packed boundary approaches remain hard throughout.
 * A group's new first vias become visible only after its complete lengths pass.
 */
export function* routeMultiEdgeReservedBusesSteps(
  params: LayerReservedBusesParams,
): Generator<LayerReservedRoutingProgress, FanoutRoutePlan[] | null, unknown> {
  const { buses, srj, layerNames } = params
  const allocated = getMultiEdgeBusTargets(params)
  if (!allocated) return null
  const targets = {
    ...allocated,
    exits: mergeLayeredBoundaryTargets({ buses, exits: allocated.exits }),
  }
  const source = prepareSourceOriginReservations(params)
  if (!source) return null
  let plans = source.sourcePlans
  let sites: ReadonlyMap<number, Point2D> =
    source.fixedViaPointsByConnectionIndex
  let paths: ReadonlyMap<number, readonly Point2D[]> = source.sourceEscapePaths
  const completed = new Set(
    buses
      .filter((bus) => bus.termination.type === "plane")
      .map((bus) => bus.busId),
  )
  const groups = new Map<string, PreparedBus[]>()
  for (const bus of buses)
    if (bus.termination.type === "boundary") {
      const key = bus.exitEdge ?? getExitEdgeForDirection(bus.direction)
      groups.set(key, [...(groups.get(key) ?? []), bus])
    }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      Number(b.some((bus) => bus.maxLengthSkew !== undefined)) -
        Number(a.some((bus) => bus.maxLengthSkew !== undefined)) ||
      Math.max(...b.map((bus) => bus.connections.length)) -
        Math.max(...a.map((bus) => bus.connections.length)),
  )
  const completedCount = () =>
    plans.filter((plan) => completed.has(plan.busId)).length
  yield { phase: "sources", routedConnectionCount: completedCount() }
  for (const group of ordered) {
    const selectedBusIds = new Set(group.map((bus) => bus.busId))
    const selected = new Set(
      group.flatMap((bus) => bus.connections.map((c) => c.connectionIndex)),
    )
    const layer = targets.targetLayerByBusId.get(group[0]!.busId)!
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
    const accepted = plans.filter(
      (plan) =>
        completed.has(plan.busId) && plan.termination.type === "boundary",
    )
    const reservedSrj = {
      ...srj,
      traces: [
        ...(srj.traces ?? []),
        ...getBoundaryApproachReservations({
          ...params,
          ...targets,
          excludedBusIds: completed,
        }),
      ],
    }
    let committed: FanoutRoutePlan[] | null = null
    for (const [attempt, routingTransit] of [[], transitLayers].entries()) {
      if (attempt && !routingTransit.length) break
      const route = routeReservedViaBusesSteps({
        ...params,
        srj: reservedSrj,
        allBuses: buses,
        buses: group,
        targetLayer: layer,
        targetLayerByBusId: targets.targetLayerByBusId,
        terminals: group.flatMap((bus) =>
          bus.connections.map((connection) => ({
            connection,
            viaPoint: sites.get(connection.connectionIndex)!,
            exitPoint: targets.exits.get(connection.connectionIndex)!,
          })),
        ),
        transitLayers: routingTransit,
        fixedViaPointsByConnectionIndex: sites,
        sourceEscapePaths: paths,
        acceptedPlans: accepted,
        routeFromSourcePads: true,
        sourceLayerTravelCost: 2,
        includeDiagonalNeighbors: true,
        tightViaChannels: true,
        ripCost: attempt ? 256 : 64,
        shuffleSeed: 1,
        maximumRipEvents: 400,
        maximumIterations:
          selected.size > 32
            ? 40_000_000
            : selected.size > 16
              ? 20_000_000
              : 5_000_000,
        maximumLocalRepairAttempts: 0,
        maximumSourceOriginRepairAttempts: 1,
      })
      let routed = route.next()
      while (!routed.done) {
        yield {
          phase: "route-layer",
          layer,
          routedConnectionCount:
            completedCount() + routed.value.routedConnectionCount,
          iterations: routed.value.iterations,
        }
        routed = route.next()
      }
      if (!routed.value) continue
      let candidate = [
        ...plans.filter((plan) => !selected.has(plan.connectionIndex)),
        ...routed.value,
      ]
      const match = (allowDistributedMatching = false) => {
        // A failed later bus must not discard useful earlier tuning. Keep it
        // only in this attempt's scratch plans until the entire group passes.
        for (const bus of group) {
          const result = matchBusPlanLengths({
            ...params,
            inputSrj: srj,
            plans: candidate,
            preparedBuses: [bus],
            sharedBoundary: bus.sharedBoundary,
            maximumWorkUnits: allowDistributedMatching ? 100_000 : 1000,
            allowMatchingInsideDenseBounds: true,
            allowSourcePrefixMatching: true,
            allowDistributedMatching,
            allowTransitLayerMatching: allowDistributedMatching,
          })
          if (!result.plans) return result
          candidate = result.plans
        }
        return { plans: candidate, failedBus: undefined }
      }
      if (group.some((bus) => bus.maxLengthSkew !== undefined)) {
        candidate =
          shortcutFanoutPlans({
            ...params,
            inputSrj: srj,
            plans: candidate,
            preparedBuses: buses,
            selectedBusIds,
            allowBlindAndBuriedVias: false,
          }) ?? candidate
        const shorter = rerouteOverlongBusLanesSteps({
          ...params,
          inputSrj: srj,
          plans: candidate,
          preparedBuses: buses,
          selectedBusIds,
          maximumPasses: 2,
          maximumConnectionAttempts: 24,
        })
        let shortened = shorter.next()
        while (!shortened.done) {
          yield {
            phase: "repair-lengths",
            layer,
            routedConnectionCount: completedCount(),
          }
          shortened = shorter.next()
        }
        candidate = shortened.value ?? candidate
      }
      yield {
        phase: "match-layer",
        layer,
        routedConnectionCount: completedCount(),
      }
      let matched = match()
      for (
        let repairAttempt = 0;
        !matched.plans && matched.failedBus && repairAttempt < 11;
        repairAttempt++
      ) {
        const repair = rerouteSourceOriginLengthsSteps({
          ...params,
          inputSrj: srj,
          plans: candidate,
          preparedBuses: buses,
          bus: matched.failedBus,
          transitLayers: repairAttempt >= 3 ? transitLayers : [],
        })
        let repaired = repair.next()
        while (!repaired.done) {
          yield {
            phase: "repair-lengths",
            layer,
            routedConnectionCount: completedCount(),
            iterations: repaired.value.iterations,
          }
          repaired = repair.next()
        }
        if (!repaired.value) {
          if (repairAttempt < 3 && transitLayers.length) {
            repairAttempt = 2
            continue
          }
          break
        }
        candidate = repaired.value
        matched = match()
      }
      // Exhaust the existing geometry cleanup before spending the larger,
      // bounded tuning budget. Legal transit folds can supply length where a
      // new target-layer meander cannot fit. Its source-path changes remain
      // provisional until the entire edge group is validated below.
      if (!matched.plans) matched = match(true)
      if (!matched.plans) continue
      const held = matched.plans.filter(
        (plan) => !selected.has(plan.connectionIndex),
      )
      const normalized = normalizeFanoutPlanCorners({
        ...params,
        inputSrj: {
          ...srj,
          traces: [...(srj.traces ?? []), ...copperTraces(held)],
        },
        plans: matched.plans.filter((plan) =>
          selected.has(plan.connectionIndex),
        ),
        preparedBuses: group,
      })
      if (!normalized) continue
      const completeCandidate = [...held, ...normalized]
      if (
        !validateRoutedCopperDrc({
          inputSrj: srj,
          routedSrj: {
            ...srj,
            traces: [...(srj.traces ?? []), ...copperTraces(completeCandidate)],
          },
          clearance: params.clearance,
          allowBlindAndBuriedVias: false,
        }).valid
      )
        continue
      committed = completeCandidate
      break
    }
    if (!committed) return null
    plans = committed
    sites = new Map(
      plans.map((plan) => [plan.connectionIndex, plan.via!.center]),
    )
    paths = new Map(
      plans.map((plan) => [
        plan.connectionIndex,
        [
          plan.sourcePoint,
          ...plan.segments
            .slice(0, plan.sourceEscapeSegmentCount ?? 1)
            .map((segment) => segment.end),
        ],
      ]),
    )
    for (const bus of group) completed.add(bus.busId)
  }
  return normalizeFanoutPlanCorners({
    ...params,
    inputSrj: srj,
    plans,
    preparedBuses: buses,
  })
}
