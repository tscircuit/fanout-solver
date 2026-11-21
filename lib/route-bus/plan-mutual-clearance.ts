import { distance, distancePointToSegment, segmentsAreClear } from "../geometry"
import { connectionsShareElectricalNet } from "../net-identity"
import { RouteSegmentSpatialIndex } from "../route-segment-spatial-index"
import type { FanoutRoutePlan, RoutedSegment, RoutedVia } from "../types"
import { getPlanSegments, getPlanVias } from "./plan-copper"
import type { BusId } from "./types"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

function viaIsNearSegment({
  via,
  segment,
  clearance,
}: {
  via: RoutedVia
  segment: RoutedSegment
  clearance: number
}): boolean {
  // Overlapping bounds still require the exact distance check below.
  const margin = (via.diameter + segment.width) / 2 + clearance + 1e-9
  return (
    via.center.x >= Math.min(segment.start.x, segment.end.x) - margin &&
    via.center.x <= Math.max(segment.start.x, segment.end.x) + margin &&
    via.center.y >= Math.min(segment.start.y, segment.end.y) - margin &&
    via.center.y <= Math.max(segment.start.y, segment.end.y) + margin
  )
}

export function planIsClearOfPlans(params: {
  plan: FanoutRoutePlan
  otherPlans: FanoutRoutePlan[]
  srj: SimpleRouteJson
  allowSameNetMerges: boolean
  clearance: number
  segmentIndexes?: WeakMap<FanoutRoutePlan, RouteSegmentSpatialIndex>
  blockingBusCounts?: Map<BusId, number>
}): boolean {
  const {
    plan,
    otherPlans,
    srj,
    allowSameNetMerges,
    clearance,
    blockingBusCounts,
    segmentIndexes,
  } = params
  const planSegments = getPlanSegments(plan)
  const planVias = getPlanVias(plan)
  for (const otherPlan of otherPlans) {
    if (
      allowSameNetMerges &&
      connectionsShareElectricalNet(
        srj,
        plan.connectionName,
        otherPlan.connectionName,
      )
    ) {
      continue
    }
    const plansShareSourcePort =
      (plan.sourcePoint.pcb_port_id &&
        plan.sourcePoint.pcb_port_id === otherPlan.sourcePoint.pcb_port_id) ||
      (plan.sourcePoint.pointId &&
        plan.sourcePoint.pointId === otherPlan.sourcePoint.pointId)
    if (plansShareSourcePort) continue
    const recordBlocker = (): void => {
      if (otherPlan.busId === plan.busId) return
      blockingBusCounts?.set(
        otherPlan.busId,
        (blockingBusCounts.get(otherPlan.busId) ?? 0) + 1,
      )
    }
    const otherSegments = getPlanSegments(otherPlan)
    const otherVias = getPlanVias(otherPlan)
    let segmentIndex = segmentIndexes?.get(otherPlan)
    if (segmentIndexes && !segmentIndex) {
      segmentIndex = new RouteSegmentSpatialIndex(otherSegments)
      segmentIndexes.set(otherPlan, segmentIndex)
    }
    for (const segment of planSegments) {
      for (const otherSegment of segmentIndex?.querySegment(
        segment,
        clearance,
      ) ?? otherSegments) {
        if (!segmentsAreClear(segment, otherSegment, clearance)) {
          recordBlocker()
          return false
        }
      }
      for (const otherVia of otherVias) {
        if (
          otherVia.spanLayers.includes(segment.layer) &&
          viaIsNearSegment({ via: otherVia, segment, clearance }) &&
          distancePointToSegment(otherVia.center, segment.start, segment.end) <
            otherVia.diameter / 2 + segment.width / 2 + clearance - 1e-9
        ) {
          recordBlocker()
          return false
        }
      }
    }
    for (const planVia of planVias) {
      for (const otherSegment of segmentIndex?.queryVia(planVia, clearance) ??
        otherSegments) {
        if (
          planVia.spanLayers.includes(otherSegment.layer) &&
          viaIsNearSegment({
            via: planVia,
            segment: otherSegment,
            clearance,
          }) &&
          distancePointToSegment(
            planVia.center,
            otherSegment.start,
            otherSegment.end,
          ) <
            planVia.diameter / 2 + otherSegment.width / 2 + clearance - 1e-9
        ) {
          recordBlocker()
          return false
        }
      }
      for (const otherVia of otherVias) {
        if (
          planVia.spanLayers.some((layer) =>
            otherVia.spanLayers.includes(layer),
          ) &&
          distance(planVia.center, otherVia.center) <
            (planVia.diameter + otherVia.diameter) / 2 + clearance - 1e-9
        ) {
          recordBlocker()
          return false
        }
      }
    }
  }
  return true
}

export function fanoutPlansAreMutuallyClear(params: {
  plans: readonly FanoutRoutePlan[]
  srj: SimpleRouteJson
  clearance: number
  allowSameNetMerges?: boolean
}): boolean {
  const { plans, srj, clearance, allowSameNetMerges = false } = params
  return plans.every((plan, index) =>
    planIsClearOfPlans({
      plan,
      otherPlans: plans.filter((_, otherIndex) => otherIndex !== index),
      srj,
      allowSameNetMerges,
      clearance,
    }),
  )
}
