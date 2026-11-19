import { routeBusAlternatives, type RouteBusParams } from "./route-bus"
import { canEnumerateIndependentBusRoutes } from "./can-enumerate-independent-bus-routes"
import type { FanoutDirection, FanoutRoutePlan, PreparedBus } from "./types"

type BusRouteKey = string

type BusRouteDomain = {
  direction: FanoutDirection
  targetLayer: string
  alternatives?: FanoutRoutePlan[][]
}

function getAllowedHeadings(bus: PreparedBus): readonly FanoutDirection[] {
  if (
    bus.termination.type === "plane" ||
    bus.exitEdge ||
    bus.preferredExit ||
    bus.requestedDirection ||
    bus.connections.some((connection) => connection.hasExplicitExitTarget)
  )
    return [bus.direction]
  return [
    bus.direction,
    ...(["left", "right", "up", "down"] as const).filter(
      (direction) => direction !== bus.direction,
    ),
  ]
}

function getAllowedLayers(bus: PreparedBus): readonly string[] {
  if (bus.termination.type === "plane") return [bus.termination.layer]
  const layers = bus.routableEscapeLayers
  if (!layers) throw new Error(`Missing escape layers for bus "${bus.busId}"`)
  return layers.filter((layer) =>
    bus.connections.every(
      (connection) =>
        !connection.hasExplicitLayeredExitTarget ||
        connection.exitTargetPoint?.layer === layer,
    ),
  )
}

function getRouteLength(plans: readonly FanoutRoutePlan[]): number {
  return Math.round(plans.reduce((total, plan) => total + plan.length, 0) * 1e9)
}

/** Enumerate atomic bus choices through the common route planner. */
export function getBusRouteChoices(
  route: Omit<RouteBusParams, "targetLayer">,
  maximumChoices: number,
): FanoutRoutePlan[][] {
  if (!canEnumerateIndependentBusRoutes(route.bus)) return []
  const headings = getAllowedHeadings(route.bus)
  const layers = getAllowedLayers(route.bus)
  const domains: BusRouteDomain[] = headings.flatMap((direction) =>
    layers.map((targetLayer) => ({ direction, targetLayer })),
  )
  if (domains.length === 0) return []
  const choicesPerDomain = Math.ceil(maximumChoices / domains.length)
  const unique = new Map<BusRouteKey, FanoutRoutePlan[]>()
  for (let rank = 0; rank < choicesPerDomain; rank++) {
    for (const domain of domains) {
      domain.alternatives ??= routeBusAlternatives(
        {
          ...route,
          bus:
            domain.direction === route.bus.direction
              ? route.bus
              : { ...route.bus, direction: domain.direction },
          targetLayer: domain.targetLayer,
        },
        choicesPerDomain,
      )
      const plans = domain.alternatives[rank]
      if (!plans) continue
      if (plans.length !== route.bus.connections.length)
        throw new Error(
          `Expected a complete atomic route for bus "${route.bus.busId}"`,
        )
      const key = JSON.stringify(
        plans.map((plan) => [plan.trace.route, plan.planeEndpointTrace?.route]),
      )
      if (!unique.has(key)) unique.set(key, plans)
      if (unique.size >= maximumChoices)
        return [...unique.values()].sort(
          (first, second) => getRouteLength(first) - getRouteLength(second),
        )
    }
  }
  return [...unique.values()].sort(
    (first, second) => getRouteLength(first) - getRouteLength(second),
  )
}
