import { getBusRouteChoices } from "./get-bus-route-choices"
import type {
  createFanoutPlanClearanceValidator,
  RouteBusParams,
} from "./route-bus"
import type { BusId } from "./route-bus/types"
import type { FanoutRoutePlan, PreparedBus } from "./types"

export interface BusRouteRepairContext {
  busesById: ReadonlyMap<BusId, PreparedBus>
  choicesByBus: Map<BusId, FanoutRoutePlan[][]>
  route: Omit<RouteBusParams, "bus" | "targetLayer" | "acceptedPlans">
  clearPlans: ReturnType<typeof createFanoutPlanClearanceValidator>
  maximumChoices: number
  remainingSearchStates: number
}

export function getCachedBusRouteChoices(
  busId: BusId,
  context: BusRouteRepairContext,
): FanoutRoutePlan[][] {
  let choices = context.choicesByBus.get(busId)
  if (choices) return choices
  const bus = context.busesById.get(busId)
  if (!bus) throw new Error(`Missing prepared bus "${busId}"`)
  choices = getBusRouteChoices(
    { ...context.route, bus, acceptedPlans: [] },
    context.maximumChoices,
  )
  context.choicesByBus.set(busId, choices)
  return choices
}
