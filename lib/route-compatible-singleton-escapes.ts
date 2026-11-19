import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  createFanoutPlanClearanceValidator,
  type RouteBusParams,
} from "./route-bus"
import {
  getOrdinarySingletonCandidates,
  getSingletonRouteCandidates,
} from "./get-singleton-route-candidates"
import type { BusId } from "./route-bus/types"
import {
  repairCompatibleSingletonEscapes,
  type SingletonEscapeContext,
} from "./repair-compatible-singleton-escapes"
import type { FanoutRoutePlan, PreparedBus } from "./types"

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
      getSingletonRouteCandidates({
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
  for (const bus of buses.toSorted(
    (first, second) =>
      Number(second.termination.type === "plane") -
      Number(first.termination.type === "plane"),
  )) {
    if (accepted.some((plan) => plan.busId === bus.busId)) continue
    const route = {
      ...routeConfig,
      srj,
      bus,
      targetLayer: busLayerAssignments[bus.busId]!,
      acceptedPlans: accepted,
    }
    for (const plan of getOrdinarySingletonCandidates(route, 1)) {
      accepted.push(plan)
      context.candidatesByBus.get(bus.busId)!.push(plan)
      break
    }
  }
  accepted = repairCompatibleSingletonEscapes(accepted, context)
  if (!context.clearPlans(accepted))
    throw new Error("Compatible singleton candidates produced invalid copper")
  return accepted
}
