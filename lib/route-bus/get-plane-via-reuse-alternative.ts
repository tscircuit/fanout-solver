import { distance } from "../geometry"
import type { FanoutRoutePlan } from "../types"
import { getExistingPlaneVias } from "./get-existing-plane-vias"
import { getAxis, directionSign } from "./directions"
import { getPlanVias } from "./plan-copper"
import { routePlaneTerminatedBus } from "./route-plane-terminated-bus"
import { getStraightOr45ConnectorVariants } from "./source-escape"
import type { RouteBusParams } from "./types"

export function getPlaneViaReuseAlternative(
  params: RouteBusParams,
  originalPlans?: readonly FanoutRoutePlan[],
): FanoutRoutePlan[] | null {
  const plans: FanoutRoutePlan[] = []
  const direction = originalPlans?.[0]?.direction ?? params.bus.direction
  const bus = { ...params.bus, direction }
  for (const connection of bus.connections) {
    const original = originalPlans?.find(
      (plan) => plan.connectionIndex === connection.connectionIndex,
    )
    let best: FanoutRoutePlan | undefined
    const routeParams = {
      ...params,
      bus,
      acceptedPlans: [...params.acceptedPlans, ...plans],
    }
    for (const via of getExistingPlaneVias(routeParams, connection)) {
      const forwardDistance =
        directionSign(direction) *
        (getAxis(via.center, direction) -
          getAxis(connection.sourcePoint, direction))
      if (forwardDistance < -1e-9) continue
      for (const path of getStraightOr45ConnectorVariants(
        connection.sourcePoint,
        via.center,
      )) {
        const pathLength = path
          .slice(1)
          .reduce(
            (length, point, index) => length + distance(path[index]!, point),
            0,
          )
        if (original && pathLength > original.length + 1e-9) continue
        if (best && pathLength >= best.length - 1e-9) continue
        const candidate = routePlaneTerminatedBus({
          ...routeParams,
          bus: { ...bus, connections: [connection] },
          fixedViaPointsByConnectionIndex: new Map([
            [connection.connectionIndex, via.center],
          ]),
          sourceEscapePaths: new Map([[connection.connectionIndex, path]]),
          // Different paths to the same site need independent static checks.
          staticClearanceCache: undefined,
        })?.[0]
        if (!candidate || candidate.via) continue
        const longerThanOriginal =
          original && candidate.length > original.length + 1e-9
        const addsVias =
          original &&
          getPlanVias(candidate).length > getPlanVias(original).length
        const losesEndpoint =
          original?.planeEndpointTrace && !candidate.planeEndpointTrace
        if (longerThanOriginal || addsVias || losesEndpoint) continue
        if (!best || candidate.length < best.length - 1e-9) best = candidate
      }
    }
    if (!best) return null
    plans.push(best)
  }
  if (bus.maxLengthSkew !== undefined) {
    const lengths = plans.map((plan) => plan.length)
    if (
      Math.max(...lengths) - Math.min(...lengths) >
      bus.maxLengthSkew + 1e-6
    ) {
      return null
    }
  }
  return plans
}
