import type { FanoutRoutePlan } from "../types"
import { routeBusAlternativesSteps } from "./route-bus-alternatives-steps"
import type { RouteBusParams } from "./types"

export function routeBusAlternatives(
  params: RouteBusParams,
  maxAlternatives = 1,
): FanoutRoutePlan[][] {
  const steps = routeBusAlternativesSteps(params, maxAlternatives)
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

export function routeBus(params: RouteBusParams): FanoutRoutePlan[] | null {
  return routeBusAlternatives(params, 1)[0] ?? null
}
