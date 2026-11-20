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
  const plans = routeBusAlternatives(params, 1)[0]
  if (plans) return plans
  const { bus } = params
  const canRetryHeading =
    bus.termination.type === "boundary" &&
    !bus.requestedDirection &&
    !bus.preferredExit &&
    !bus.exitEdge &&
    !bus.connections.some((connection) => connection.hasExplicitExitTarget)
  if (!canRetryHeading) return null

  for (const direction of ["left", "right", "up", "down"] as const) {
    if (direction === bus.direction) continue
    const plans = routeBusAlternatives(
      { ...params, bus: { ...bus, direction } },
      1,
    )[0]
    if (plans) return plans
  }
  return null
}
