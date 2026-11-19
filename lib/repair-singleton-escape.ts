import {
  fanoutPlansAreClear,
  fanoutPlansAreMutuallyClear,
  routeBusAlternatives,
  type RouteBusParams,
} from "./route-bus"
import { selectCompatibleCandidates } from "./select-compatible-candidates"
import type { FanoutRoutePlan, PreparedBus } from "./types"

/** Add a blocked escape only when every displaced escape can be replaced. */
export function repairSingletonEscape(params: {
  route: RouteBusParams
  buses: readonly PreparedBus[]
}): FanoutRoutePlan[] | null {
  const { route, buses } = params
  if (
    !buses.every((bus) => bus.connections.length === 1) ||
    !buses.some((bus) => bus.termination.type === "plane") ||
    !buses.some((bus) => bus.termination.type === "boundary")
  )
    return null

  const alternatives = routeBusAlternatives(
    {
      ...route,
      acceptedPlans: [],
      staticClearanceCache: undefined,
      blockingBusCounts: undefined,
    },
    2,
  )
  for (const [addition] of alternatives) {
    if (!addition) throw new Error("Expected one plan for a singleton escape")
    const blockers = route.acceptedPlans.filter(
      (plan) =>
        !fanoutPlansAreMutuallyClear({
          plans: [addition, plan],
          srj: route.srj,
          clearance: route.clearance,
          allowSameNetMerges: route.allowSameNetMerges,
        }),
    )
    if (blockers.length === 0 || blockers.length > 2) continue
    const fixedPlans = [
      ...route.acceptedPlans.filter((plan) => !blockers.includes(plan)),
      addition,
    ]
    const candidateSets = blockers.map((blocker) => {
      const bus = buses.find((candidate) => candidate.busId === blocker.busId)
      if (!bus) throw new Error(`Missing prepared bus "${blocker.busId}"`)
      return routeBusAlternatives(
        {
          ...route,
          bus,
          targetLayer: blocker.targetLayer,
          acceptedPlans: fixedPlans,
          staticClearanceCache: undefined,
          blockingBusCounts: undefined,
        },
        2,
      ).map(([replacement]) => {
        if (!replacement)
          throw new Error("Expected one plan for a singleton replacement")
        return replacement
      })
    })
    const { selection } = selectCompatibleCandidates({
      candidateSets,
      areCompatible: (first, second) =>
        fanoutPlansAreMutuallyClear({
          plans: [first, second],
          srj: route.srj,
          clearance: route.clearance,
          allowSameNetMerges: route.allowSameNetMerges,
        }),
      maximumSearchStates: 64,
    })
    if (!selection) continue
    const repairedPlans = [...fixedPlans, ...selection]
    if (
      fanoutPlansAreClear({
        plans: repairedPlans,
        srj: route.srj,
        sharedBoundary: route.bus.sharedBoundary,
        clearance: route.clearance,
        allowBlindAndBuriedVias: route.allowBlindAndBuriedVias,
        allowSameNetMerges: route.allowSameNetMerges,
      })
    )
      return repairedPlans
  }
  return null
}
