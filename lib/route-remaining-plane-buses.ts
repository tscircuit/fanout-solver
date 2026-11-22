import { routeBus, type RouteBusParams } from "./route-bus"
import { getPlanVias } from "./route-bus/plan-copper"
import type { AssignmentAttempt, PreparedBus } from "./types"

/** Refine the best failed assignment without changing assignment search. */
export function routeRemainingPlaneBuses(
  params: Omit<RouteBusParams, "bus" | "targetLayer" | "acceptedPlans"> & {
    buses: readonly PreparedBus[]
    attempt: AssignmentAttempt
  },
): Omit<AssignmentAttempt, "outputSrj"> {
  const { buses, attempt } = params
  const plans = [...attempt.plans]
  const failedBusIds = [...attempt.summary.failedBusIds]
  let addedRouteCost = 0
  for (const busId of attempt.summary.failedBusIds) {
    const bus = buses.find((candidate) => candidate.busId === busId)
    if (!bus) throw new Error(`Fanout bus "${busId}" is missing`)
    if (bus.termination.type !== "plane") continue
    const additions = routeBus({
      ...params,
      bus,
      targetLayer: bus.termination.layer,
      acceptedPlans: plans,
      allowSameNetPlaneMerges: true,
    })
    if (!additions) continue
    plans.push(...additions)
    failedBusIds.splice(failedBusIds.indexOf(busId), 1)
    addedRouteCost += additions.reduce(
      (cost, plan) => cost + plan.length + getPlanVias(plan).length * 0.1,
      0,
    )
  }
  const addedConnectionCount = plans.length - attempt.plans.length
  const addedBusCount =
    attempt.summary.failedBusIds.length - failedBusIds.length
  if (addedConnectionCount === 0) return attempt
  return {
    plans,
    summary: {
      ...attempt.summary,
      routedConnectionCount: plans.length,
      routedBusCount: attempt.summary.routedBusCount + addedBusCount,
      failedBusIds,
      score:
        attempt.summary.score -
        addedConnectionCount * 1_000_000 -
        addedBusCount * 100_000 +
        addedRouteCost,
    },
  }
}
