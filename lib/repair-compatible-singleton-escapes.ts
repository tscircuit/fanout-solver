import type { createFanoutPlanClearanceValidator } from "./route-bus"
import type { BusId } from "./route-bus/types"
import { selectCompatibleCandidates } from "./select-compatible-candidates"
import type { FanoutRoutePlan } from "./types"

export interface SingletonEscapeContext {
  candidatesByBus: Map<BusId, FanoutRoutePlan[]>
  clearPlans: ReturnType<typeof createFanoutPlanClearanceValidator>
}

function getReplacementGroups(
  params: {
    addition: FanoutRoutePlan
    blockers: FanoutRoutePlan[]
    accepted: FanoutRoutePlan[]
  },
  context: SingletonEscapeContext,
): FanoutRoutePlan[][] {
  const { addition, blockers, accepted } = params
  const groups = [blockers]
  if (blockers.length !== 1) return groups
  const blocker = blockers[0]!
  for (const option of context.candidatesByBus.get(blocker.busId)!) {
    if (!context.clearPlans.mutuallyClear([option, addition])) continue
    const neighbors = accepted.filter(
      (plan) =>
        plan !== blocker && !context.clearPlans.mutuallyClear([plan, option]),
    )
    if (neighbors.length !== 1) continue
    const neighbor = neighbors[0]!
    if (!groups.some((group) => group.includes(neighbor)))
      groups.push([blocker, neighbor])
  }
  return groups
}

function replaceBlockedEscapes(
  params: {
    addition: FanoutRoutePlan
    moved: FanoutRoutePlan[]
    accepted: FanoutRoutePlan[]
  },
  context: SingletonEscapeContext,
): FanoutRoutePlan[] | undefined {
  const { addition, moved, accepted } = params
  const fixed = [...accepted.filter((plan) => !moved.includes(plan)), addition]
  const candidateSets = moved.map((plan) =>
    context.candidatesByBus.get(plan.busId)!.filter(
      (candidate) => context.clearPlans.mutuallyClear([...fixed, candidate]),
    ),
  )
  if (candidateSets.some((candidates) => candidates.length === 0)) return
  const { selection } = selectCompatibleCandidates({
    candidateSets,
    areCompatible: (first, second) =>
      context.clearPlans.mutuallyClear([first, second]),
    maximumSearchStates: 64,
  })
  if (selection) return [...fixed, ...selection]
}

/** Move no more than two existing escapes, retaining all other accepted copper. */
export function repairCompatibleSingletonEscapes(
  acceptedPlans: FanoutRoutePlan[],
  context: SingletonEscapeContext,
): FanoutRoutePlan[] {
  let accepted = acceptedPlans
  for (const [busId, candidates] of context.candidatesByBus) {
    if (accepted.some((plan) => plan.busId === busId)) continue
    for (const addition of candidates) {
      const blockers = accepted.filter(
        (plan) => !context.clearPlans.mutuallyClear([plan, addition]),
      )
      if (blockers.length > 2) continue
      if (blockers.length === 0) {
        accepted = [...accepted, addition]
        break
      }
      const groups = getReplacementGroups(
        { addition, blockers, accepted },
        context,
      )
      let repaired: FanoutRoutePlan[] | undefined
      for (const moved of groups) {
        repaired = replaceBlockedEscapes({ addition, moved, accepted }, context)
        if (repaired) break
      }
      if (!repaired) continue
      accepted = repaired
      break
    }
  }
  return accepted
}
