import { routeBusAlternatives, type RouteBusParams } from "./route-bus"
import type { FanoutRoutePlan } from "./types"

type SingletonRouteKey = string

export function getSingletonCandidateLayers(route: RouteBusParams): readonly string[] {
  const { bus } = route
  if (bus.termination.type === "plane") return [bus.termination.layer]
  const allowed = bus.routableEscapeLayers
  if (!allowed) throw new Error(`Missing escape layers for bus "${bus.busId}"`)
  const connection = bus.connections[0]!
  if (!connection.hasExplicitLayeredExitTarget) return allowed
  const targetLayer = connection.exitTargetPoint?.layer
  if (!targetLayer) throw new Error(`Missing exit layer for bus "${bus.busId}"`)
  return allowed.filter((layer) => layer === targetLayer)
}

export function getSingletonRouteCandidates(
  route: RouteBusParams,
): FanoutRoutePlan[] {
  const allowed = getSingletonCandidateLayers(route)
  if (!allowed.includes(route.targetLayer))
    throw new Error(
      `Assigned escape layer is unavailable for bus "${route.bus.busId}"`,
    )
  const layers = [
    route.targetLayer,
    ...allowed.filter((layer) => layer !== route.targetLayer),
  ]
  const candidates = new Map<SingletonRouteKey, FanoutRoutePlan>()
  for (const targetLayer of layers) {
    const maximumAlternatives = targetLayer === route.targetLayer ? 8 : 2
    for (const plans of routeBusAlternatives(
      { ...route, targetLayer },
      maximumAlternatives,
    )) {
      if (plans.length !== 1)
        throw new Error("Expected one plan per singleton escape candidate")
      const plan = plans[0]!
      const key = JSON.stringify([
        plan.trace.route,
        plan.planeEndpointTrace?.route,
      ])
      if (!candidates.has(key)) candidates.set(key, plan)
    }
  }
  return [...candidates.values()].sort(
    (first, second) =>
      Math.round(first.length * 1e9) - Math.round(second.length * 1e9),
  )
}
