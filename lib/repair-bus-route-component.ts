import {
  getCachedBusRouteChoices,
  type BusRouteRepairContext,
} from "./bus-route-repair-context"
import type { BusId } from "./route-bus/types"
import { selectCompatibleCandidates } from "./select-compatible-candidates"
import type { FanoutRoutePlan } from "./types"

/** Restore every displaced bus before committing an additional atomic route. */
export function repairBusRouteComponent(
  params: {
    addition: FanoutRoutePlan[]
    acceptedByBus: ReadonlyMap<BusId, FanoutRoutePlan[]>
  },
  context: BusRouteRepairContext,
): FanoutRoutePlan[] | undefined {
  const { addition, acceptedByBus } = params
  const component = new Set<BusId>()
  for (const [busId, plans] of acceptedByBus) {
    if (!context.clearPlans.mutuallyClear([...addition, ...plans]))
      component.add(busId)
  }
  let selection = [addition]
  while (component.size > 0) {
    if (context.remainingSearchStates <= 0) return
    const domains = [...component].map((busId) => [
      acceptedByBus.get(busId)!,
      ...getCachedBusRouteChoices(busId, context),
    ])
    const choicesPerBus = Math.max(
      1,
      Math.floor(context.maximumChoices / domains.length),
    )
    const result = selectCompatibleCandidates({
      candidateSets: [
        [addition],
        ...domains.map((choices) => choices.slice(0, choicesPerBus)),
      ],
      areCompatible: (first, second) =>
        context.clearPlans.mutuallyClear([...first, ...second]),
      maximumSearchStates: context.remainingSearchStates,
    })
    context.remainingSearchStates -= Math.max(1, result.searchStates)
    if (!result.selection) return
    selection = result.selection
    const replacements = selection.flat()
    const neighbors = [...acceptedByBus].filter(
      ([busId, plans]) =>
        !component.has(busId) &&
        !context.clearPlans.mutuallyClear([...replacements, ...plans]),
    )
    if (neighbors.length === 0) break
    for (const [busId] of neighbors) component.add(busId)
  }
  const plans = [
    ...[...acceptedByBus].flatMap(([busId, plans]) =>
      component.has(busId) ? [] : plans,
    ),
    ...selection.flat(),
  ]
  if (!context.clearPlans(plans))
    throw new Error("Bus conflict repair produced invalid copper")
  return plans
}
