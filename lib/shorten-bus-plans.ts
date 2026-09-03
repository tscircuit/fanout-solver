import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { fanoutPlansAreClear } from "./route-bus"
import { routeViaMinimalWinding } from "./route-via-minimal-winding"
import type { Bounds, FanoutRoutePlan, PreparedBus } from "./types"

/** Revisit excessive winding detours after provisional reservations are gone. */
export function shortenBusPlans(params: {
  plans: readonly FanoutRoutePlan[]
  bus: PreparedBus
  srj: SimpleRouteJson
  sharedBoundary: Bounds
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  allowSameNetMerges: boolean
}): FanoutRoutePlan[] {
  const { bus } = params
  let plans = [...params.plans]
  if (bus.maxLengthSkew === undefined) return plans
  const busPlans = plans
    .filter((plan) => plan.busId === bus.busId)
    .toSorted((first, second) => second.length - first.length)
  for (const plan of busPlans) {
    const minimumLength = Math.min(
      ...plans.filter((p) => p.busId === bus.busId).map((p) => p.length),
    )
    if (plan.length - minimumLength <= bus.maxLengthSkew) continue
    // Retain the original source dogbone, through-via and boundary endpoint.
    if (
      !plan.via ||
      plan.additionalVias?.length ||
      plan.planeEndpointVia ||
      plan.segments.filter((segment) => segment.layer === plan.sourceLayer)
        .length !== 1
    )
      continue
    const connection = bus.connections.find(
      (c) => c.connectionIndex === plan.connectionIndex,
    )!
    for (const alignGridToPads of [true, false]) {
      const candidate = routeViaMinimalWinding({
        ...params,
        bus: {
          ...bus,
          connections: [connection],
          routableEscapeLayers: [plan.targetLayer],
        },
        terminals: [
          { connection, viaPoint: plan.via.center, exitPoint: plan.exitPoint },
        ],
        targetLayer: plan.targetLayer,
        acceptedPlans: plans.filter((p) => p !== plan),
        allowBlindAndBuriedVias: false,
        gridStepDivisor: 2,
        alignGridToPads,
        maximumRouteOrderAttempts: 1,
      })?.[0]
      if (!candidate || candidate.length >= plan.length - 1e-6) continue
      const nextPlans = plans.map((p) => (p === plan ? candidate : p))
      if (
        !fanoutPlansAreClear({
          ...params,
          plans: nextPlans,
          allowBlindAndBuriedVias: false,
        })
      )
        continue
      plans = nextPlans
      break
    }
  }
  return plans
}
