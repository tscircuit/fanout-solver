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
    const originalPlan = originalPlans?.find(
      (plan) => plan.connectionIndex === connection.connectionIndex,
    )
    let bestPlan: FanoutRoutePlan | undefined
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
        if (originalPlan && pathLength > originalPlan.length + 1e-9) continue
        if (bestPlan && pathLength >= bestPlan.length - 1e-9) continue
        const candidatePlan = routePlaneTerminatedBus({
          ...routeParams,
          bus: { ...bus, connections: [connection] },
          fixedViaPointsByConnectionIndex: new Map([
            [connection.connectionIndex, via.center],
          ]),
          sourceEscapePaths: new Map([[connection.connectionIndex, path]]),
          // Different paths to the same site need independent static checks.
          staticClearanceCache: undefined,
        })?.[0]
        if (!candidatePlan || candidatePlan.via) continue
        const longerThanOriginal =
          originalPlan && candidatePlan.length > originalPlan.length + 1e-9
        const addsVias =
          originalPlan &&
          getPlanVias(candidatePlan).length > getPlanVias(originalPlan).length
        const losesEndpoint =
          originalPlan?.planeEndpointTrace && !candidatePlan.planeEndpointTrace
        if (longerThanOriginal || addsVias || losesEndpoint) continue
        if (!bestPlan || candidatePlan.length < bestPlan.length - 1e-9)
          bestPlan = candidatePlan
      }
    }
    if (!bestPlan) return null
    plans.push(bestPlan)
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
