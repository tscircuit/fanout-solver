import { routeBusAlternatives, type RouteBusParams } from "./route-bus"
import { getPlaneGeometryCandidates } from "./get-plane-geometry-candidates"
import { getSingletonCandidateHeadings } from "./get-singleton-candidate-headings"
import { getPlanSegments } from "./route-bus/plan-copper"
import type { FanoutRoutePlan } from "./types"

type SingletonRouteKey = string

export function getSingletonCandidateLayers(
  route: RouteBusParams,
): readonly string[] {
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

export function* getOrdinarySingletonCandidates(
  route: RouteBusParams,
  maximumAlternatives = 2,
): Generator<FanoutRoutePlan> {
  const traceWidth = route.bus.singletonTraceWidth ?? route.traceWidth
  for (const direction of getSingletonCandidateHeadings(route.bus)) {
    const bus =
      direction === route.bus.direction
        ? route.bus
        : { ...route.bus, direction }
    for (const targetLayer of getSingletonCandidateLayers(route)) {
      for (const plans of routeBusAlternatives(
        { ...route, bus, targetLayer, traceWidth },
        maximumAlternatives,
      )) {
        if (plans.length !== 1)
          throw new Error("Expected one plan per singleton escape candidate")
        const plan = plans[0]!
        const preservesWidth = getPlanSegments(plan).every(
          (segment) => Math.abs(segment.width - traceWidth) <= 1e-9,
        )
        if (preservesWidth) yield plan
      }
    }
  }
}

export function getSingletonRouteCandidates(
  route: RouteBusParams,
): FanoutRoutePlan[] {
  route = {
    ...route,
    traceWidth: route.bus.singletonTraceWidth ?? route.traceWidth,
  }
  const candidates = new Map<SingletonRouteKey, FanoutRoutePlan>()
  for (const plan of getOrdinarySingletonCandidates(route)) {
    const key = JSON.stringify([plan.trace.route, plan.planeEndpointTrace?.route])
    if (!candidates.has(key)) candidates.set(key, plan)
  }
  if (route.bus.termination.type === "plane") {
    for (const plan of getPlaneGeometryCandidates(route)) {
      const key = JSON.stringify([plan.trace.route, plan.planeEndpointTrace?.route])
      if (!candidates.has(key)) candidates.set(key, plan)
    }
  }
  return [...candidates.values()].sort(
    (first, second) =>
      Math.round(first.length * 1e9) - Math.round(second.length * 1e9),
  )
}
