import { circleFitsInsideObstacle, distance } from "../geometry"
import type { FanoutRoutePlan, RoutedSegment } from "../types"

export function getPlanSegments(plan: FanoutRoutePlan): RoutedSegment[] {
  return plan.planeEndpointSegments?.length
    ? [...plan.segments, ...plan.planeEndpointSegments]
    : plan.segments
}

export function getPlanVias(
  plan: FanoutRoutePlan,
): NonNullable<FanoutRoutePlan["via"]>[] {
  if (!plan.additionalVias?.length && !plan.planeEndpointVia) {
    return plan.via ? [plan.via] : []
  }
  return [
    plan.via,
    ...(plan.additionalVias ?? []),
    plan.planeEndpointVia,
  ].filter((via): via is NonNullable<FanoutRoutePlan["via"]> => Boolean(via))
}

export function viaFitsInsidePlanSourcePad(
  plan: FanoutRoutePlan,
  via: NonNullable<FanoutRoutePlan["via"]>,
): boolean {
  return (
    distance(via.center, plan.sourcePoint) <= 1e-9 &&
    circleFitsInsideObstacle({
      center: via.center,
      diameter: via.diameter,
      obstacle: plan.sourceObstacle,
    })
  )
}
