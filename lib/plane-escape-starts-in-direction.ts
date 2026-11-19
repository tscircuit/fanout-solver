import { distance, pointIsInsideObstacle } from "./geometry"
import { directionSign, getAxis } from "./route-bus/directions"
import type { FanoutDirection, FanoutRoutePlan } from "./types"

export function planeEscapeStartsInDirection(
  plan: FanoutRoutePlan,
  direction: FanoutDirection,
): boolean {
  const lead = plan.segments.find(
    (segment) =>
      segment.layer === plan.sourceLayer &&
      !pointIsInsideObstacle(segment.end, plan.sourceObstacle),
  )
  if (!lead) {
    return !!plan.via && distance(plan.sourcePoint, plan.via.center) <= 1e-9
  }
  const signedTravel =
    (getAxis(lead.end, direction) - getAxis(lead.start, direction)) *
    directionSign(direction)
  return signedTravel > 1e-9
}
