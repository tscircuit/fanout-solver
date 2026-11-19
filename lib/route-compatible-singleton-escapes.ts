import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  createFanoutPlanClearanceValidator,
  routeBusAlternatives,
  type RouteBusParams,
} from "./route-bus"
import type { BusId } from "./route-bus/types"
import {
  repairCompatibleSingletonEscapes,
  type SingletonEscapeContext,
} from "./repair-compatible-singleton-escapes"
import type { FanoutRoutePlan, PreparedBus } from "./types"

type SingletonRouteKey = string

function getSingletonCandidates(route: RouteBusParams): FanoutRoutePlan[] {
  const candidates = new Map<SingletonRouteKey, FanoutRoutePlan>()
  for (const plans of routeBusAlternatives(route, 8)) {
    if (plans.length !== 1)
      throw new Error("Expected one plan per singleton escape candidate")
    const plan = plans[0]!
    const key = JSON.stringify([
      plan.trace.route,
      plan.planeEndpointTrace?.route,
    ])
    if (!candidates.has(key)) candidates.set(key, plan)
  }
  return [...candidates.values()].sort(
    (first, second) =>
      Math.round(first.length * 1e9) - Math.round(second.length * 1e9),
  )
}

export function routeCompatibleSingletonEscapes(params: {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  busLayerAssignments: Readonly<Record<BusId, string>>
  routeConfig: Omit<
    RouteBusParams,
    "srj" | "bus" | "targetLayer" | "acceptedPlans"
  >
}): FanoutRoutePlan[] {
  const { srj, buses, busLayerAssignments, routeConfig } = params
  const context: SingletonEscapeContext = {
    candidatesByBus: new Map(),
    clearPlans: createFanoutPlanClearanceValidator({
      ...routeConfig,
      srj,
      sharedBoundary: buses[0]!.sharedBoundary,
    }),
  }
  for (const bus of buses) {
    if (bus.connections.length !== 1)
      throw new Error(`Expected singleton bus "${bus.busId}"`)
    const targetLayer = busLayerAssignments[bus.busId]
    if (!targetLayer) throw new Error(`Missing layer for bus "${bus.busId}"`)
    context.candidatesByBus.set(
      bus.busId,
      getSingletonCandidates({
        ...routeConfig,
        srj,
        bus,
        targetLayer,
        acceptedPlans: [],
      }),
    )
  }
  let pending = [...context.candidatesByBus.values()].filter(
    (candidates) => candidates.length > 0,
  )
  let accepted: FanoutRoutePlan[] = []
  while (pending.length > 0) {
    pending.sort(
      (first, second) =>
        Number(second[0]!.termination.type === "plane") -
          Number(first[0]!.termination.type === "plane") ||
        first.length - second.length,
    )
    const chosen = pending[0]![0]!
    accepted.push(chosen)
    pending = pending
      .slice(1)
      .map((candidates) =>
        candidates.filter((plan) =>
          context.clearPlans.mutuallyClear([plan, chosen]),
        ),
      )
      .filter((candidates) => candidates.length > 0)
  }
  accepted = repairCompatibleSingletonEscapes(accepted, context)
  if (!context.clearPlans(accepted))
    throw new Error("Compatible singleton candidates produced invalid copper")
  return accepted
}
