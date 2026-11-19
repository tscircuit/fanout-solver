import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  getCachedBusRouteChoices,
  type BusRouteRepairContext,
} from "./bus-route-repair-context"
import { getBusRouteChoices } from "./get-bus-route-choices"
import { repairBusRouteComponent } from "./repair-bus-route-component"
import {
  createFanoutPlanClearanceValidator,
  type RouteBusParams,
} from "./route-bus"
import type { BusId } from "./route-bus/types"
import type { FanoutRoutePlan, PreparedBus } from "./types"

function groupAcceptedPlans(
  plans: readonly FanoutRoutePlan[],
): Map<BusId, FanoutRoutePlan[]> {
  const groups = new Map<BusId, FanoutRoutePlan[]>()
  for (const plan of plans) {
    const group = groups.get(plan.busId) ?? []
    group.push(plan)
    groups.set(plan.busId, group)
  }
  return groups
}

/** Retry failed ordinary buses against actual copper, then repair local conflicts. */
export function* repairFailedBusRoutesSteps(params: {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  plans: FanoutRoutePlan[]
  maximumSearchStates: number
  routeConfig: Omit<
    RouteBusParams,
    "srj" | "bus" | "targetLayer" | "acceptedPlans"
  >
}): Generator<undefined, FanoutRoutePlan[], unknown> {
  const { srj, buses, routeConfig } = params
  let accepted = params.plans
  const context: BusRouteRepairContext = {
    busesById: new Map(buses.map((bus) => [bus.busId, bus])),
    choicesByBus: new Map(),
    route: { ...routeConfig, srj },
    clearPlans: createFanoutPlanClearanceValidator({
      ...routeConfig,
      srj,
      sharedBoundary: buses[0]!.sharedBoundary,
    }),
    maximumChoices: Math.max(1, Math.floor(params.maximumSearchStates)),
    remainingSearchStates: Math.max(1, Math.floor(params.maximumSearchStates)),
  }
  for (const bus of buses) {
    if (accepted.some((plan) => plan.busId === bus.busId)) continue
    const [retry] = getBusRouteChoices(
      { ...context.route, bus, acceptedPlans: accepted },
      1,
    )
    if (retry) {
      const plans = [...accepted, ...retry]
      if (!context.clearPlans(plans))
        throw new Error("Ordinary bus retry produced invalid copper")
      accepted = plans
    }
    yield
  }
  for (const bus of buses) {
    if (accepted.some((plan) => plan.busId === bus.busId)) continue
    if (context.remainingSearchStates <= 0) break
    const acceptedByBus = groupAcceptedPlans(accepted)
    for (const addition of getCachedBusRouteChoices(bus.busId, context)) {
      const repaired = repairBusRouteComponent(
        { addition, acceptedByBus },
        context,
      )
      if (!repaired) continue
      accepted = repaired
      break
    }
    yield
  }
  return accepted
}
