import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distance } from "./geometry"
import { matchBusPlanLengths } from "./match-bus-lengths"
import {
  routeReservedViaBusesSteps,
  type ReservedViaBusesProgress,
} from "./route-reserved-via-buses"
import { shortcutFanoutPlans } from "./shortcut-fanout-plans"
import type { FanoutRoutePlan, PreparedBus } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

interface RepairWideSourceLengthsParams {
  inputSrj: SimpleRouteJson
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  completedBuses: readonly PreparedBus[]
  selectedBusIds: ReadonlySet<string>
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
}

/**
 * A source prefix can itself exceed the complete bus's length allowance.
 * Shorten that retained copper, distribute the remaining tuning, then try one
 * new first via for a blocked shortest lane. Everything stays provisional
 * until the entire completed group matches and every original source clears.
 */
export function* repairWideSourceLengthsSteps(
  params: RepairWideSourceLengthsParams,
): Generator<ReservedViaBusesProgress, FanoutRoutePlan[] | null> {
  const { inputSrj, preparedBuses, completedBuses, selectedBusIds } = params
  const selected = completedBuses.filter(
    (bus) =>
      selectedBusIds.has(bus.busId) &&
      bus.termination.type === "boundary" &&
      bus.connections.length > 2 &&
      bus.allowedLayers?.length === 1 &&
      bus.maxLengthSkew !== undefined,
  )
  if (
    !selected.some((bus) => {
      const own = params.plans.filter((plan) => plan.busId === bus.busId)
      const allowance =
        Math.min(...own.map((plan) => plan.length)) + bus.maxLengthSkew!
      return own.some(
        (plan) =>
          plan.segments
            .slice(0, plan.sourceEscapeSegmentCount ?? 1)
            .reduce(
              (sum, segment) => sum + distance(segment.start, segment.end),
              0,
            ) >
          allowance + 1e-6,
      )
    })
  )
    return null
  const connections = preparedBuses.flatMap((bus) => bus.connections)
  const byIndex = new Map(connections.map((c) => [c.connectionIndex, c]))
  const assertOriginals = (plans: readonly FanoutRoutePlan[]) => {
    if (
      byIndex.size !== inputSrj.connections.length ||
      plans.length !== byIndex.size ||
      new Set(plans.map((plan) => plan.connectionIndex)).size !==
        byIndex.size ||
      plans.some((plan) => {
        const source = byIndex.get(plan.connectionIndex)
        return (
          source?.connection.name !== plan.connectionName ||
          source.sourceObstacle !== plan.sourceObstacle
        )
      })
    )
      throw new Error(
        "Wide source length repair requires every original source",
      )
  }
  assertOriginals(params.plans)
  const completedIds = new Set(completedBuses.map((bus) => bus.busId))
  const unroutedSourceBuses = preparedBuses.filter(
    (bus) =>
      bus.termination.type === "boundary" && !completedIds.has(bus.busId),
  )
  const shortened = shortcutFanoutPlans({
    ...params,
    preparedBuses: completedBuses,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    allowSourcePrefixShortcuts: true,
  })
  if (!shortened) return null
  let plans = shortened
  const match = () => {
    let provisional = plans
    const result = matchBusPlanLengths({
      ...params,
      plans,
      preparedBuses: completedBuses,
      sharedBoundary: selected[0]!.sharedBoundary,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
      allowMatchingInsideDenseBounds: true,
      allowSourcePrefixMatching: true,
      allowTransitLayerMatching: true,
      allowDistributedMatching: true,
      allowPairLaneSpreading: true,
      allowUnconstrainedLaneRerouting: true,
      unroutedSourceBuses,
      maximumWorkUnits: 100_000,
      candidatePlansAreFeasible: (candidate) => {
        assertOriginals(candidate)
        provisional = [...candidate]
        return true
      },
    })
    plans = result.plans ?? provisional
    return result
  }
  let matched = match()
  if (!matched.plans) {
    const bus = matched.failedBus
    if (!selected.some((candidate) => candidate.busId === bus.busId))
      return null
    const own = plans.filter((plan) => plan.busId === bus.busId)
    const shortest = own.toSorted(
      (a, b) =>
        a.length - b.length || a.connectionName.localeCompare(b.connectionName),
    )[0]!
    if (
      Math.max(...own.map((plan) => plan.length)) - shortest.length <=
        bus.maxLengthSkew! + 1e-6 ||
      plans.some((plan) => !plan.via)
    )
      return null
    const connection = byIndex.get(shortest.connectionIndex)!
    const replacements = yield* routeReservedViaBusesSteps({
      ...params,
      srj: inputSrj,
      allBuses: preparedBuses,
      buses: [{ ...bus, connections: [connection] }],
      targetLayer: shortest.targetLayer,
      transitLayers: [],
      terminals: [
        {
          connection,
          viaPoint: shortest.via!.center,
          exitPoint: shortest.exitPoint,
        },
      ],
      fixedViaPointsByConnectionIndex: new Map(
        plans.map((plan) => [plan.connectionIndex, plan.via!.center]),
      ),
      sourceEscapePaths: new Map(
        plans.map((plan) => [
          plan.connectionIndex,
          [
            plan.sourcePoint,
            ...plan.segments
              .slice(0, plan.sourceEscapeSegmentCount ?? 1)
              .map((s) => s.end),
          ],
        ]),
      ),
      acceptedPlans: plans.filter((plan) => plan !== shortest),
      routeFromSourcePads: true,
      sourceLayerTravelCost: 3,
      includeDiagonalNeighbors: true,
      tightViaChannels: true,
      ripCost: 64,
      shuffleSeed: 1,
      maximumIterations: 2_000_000,
      maximumLocalRepairAttempts: 0,
    })
    if (!replacements || replacements.length !== 1) return null
    plans = plans.map((plan) => (plan === shortest ? replacements[0]! : plan))
    matched = match()
  }
  if (!matched.plans) return null
  assertOriginals(matched.plans)
  return validateRoutedCopperDrc({
    inputSrj,
    routedSrj: {
      ...inputSrj,
      traces: [
        ...(inputSrj.traces ?? []),
        ...matched.plans.flatMap((plan) => [
          plan.trace,
          ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance: params.clearance,
    allowBlindAndBuriedVias: false,
  }).valid
    ? matched.plans
    : null
}
