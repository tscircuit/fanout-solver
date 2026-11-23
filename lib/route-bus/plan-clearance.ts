import { connectionsShareElectricalNet } from "../net-identity"
import { RouteSegmentSpatialIndex } from "../route-segment-spatial-index"
import type { Bounds, FanoutRoutePlan } from "../types"
import { getPlanSegments } from "./plan-copper"
import { planIsClearOfPlans } from "./plan-mutual-clearance"
import {
  planIsStaticallyClear,
  type StaticPlanSegmentCache,
} from "./plan-static-clearance"
import type { BusId, RouteBusStaticClearanceCache } from "./types"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

export function planIsClear(params: {
  plan: FanoutRoutePlan
  otherPlans: FanoutRoutePlan[]
  staticClearanceCache?: RouteBusStaticClearanceCache
  blockingBusCounts?: Map<BusId, number>
  cacheKey: string
  srj: SimpleRouteJson
  sharedBoundary: Bounds
  clearance: number
  allowBlindAndBuriedVias: boolean
  allowSameNetMerges: boolean
  allowSameNetPlaneMerges?: boolean
}): boolean {
  const {
    plan,
    otherPlans,
    staticClearanceCache,
    blockingBusCounts,
    cacheKey,
    srj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias,
    allowSameNetMerges,
    allowSameNetPlaneMerges = false,
  } = params
  let staticallyClear = staticClearanceCache?.get(cacheKey)
  if (staticallyClear === undefined) {
    staticallyClear = planIsStaticallyClear({
      plan,
      srj,
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias,
      allowSameNetMerges,
      allowSameNetPlaneMerges,
    })
    staticClearanceCache?.set(cacheKey, staticallyClear)
  }
  return (
    staticallyClear &&
    planIsClearOfPlans({
      plan,
      otherPlans,
      srj,
      allowSameNetMerges,
      allowSameNetPlaneMerges,
      clearance,
      blockingBusCounts,
    })
  )
}

/**
 * Validate a complete set of fanout plans against the source SRJ and against
 * one another. This is intentionally separate from route search so every
 * route-producing strategy can share the same final safety invariant.
 */
export function fanoutPlansAreClear(params: {
  plans: readonly FanoutRoutePlan[]
  srj: SimpleRouteJson
  sharedBoundary: Bounds
  clearance: number
  allowBlindAndBuriedVias?: boolean
  allowSameNetMerges?: boolean
  /** Share copper between declared plane drops without merging signal branches. */
  allowSameNetPlaneMerges?: boolean
}): boolean {
  const {
    plans,
    srj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
    allowSameNetPlaneMerges = false,
  } = params
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index]!
    if (
      !planIsStaticallyClear({
        plan,
        srj,
        sharedBoundary,
        clearance,
        allowBlindAndBuriedVias,
        allowSameNetMerges:
          allowSameNetMerges ||
          (allowSameNetPlaneMerges && plan.termination.type === "plane"),
      })
    ) {
      return false
    }
    const otherPlans = plans.filter(
      (other, otherIndex) =>
        otherIndex !== index &&
        !(
          allowSameNetPlaneMerges &&
          plan.termination.type === "plane" &&
          other.termination.type === "plane" &&
          connectionsShareElectricalNet(
            srj,
            plan.connectionName,
            other.connectionName,
          )
        ),
    )
    if (
      !planIsClearOfPlans({
        allowSameNetPlaneMerges,
        plan,
        otherPlans,
        srj,
        allowSameNetMerges,
        clearance,
      })
    ) {
      return false
    }
  }
  return true
}

/** Reuse clearance results while a caller replaces immutable route plans.
 * Keep one validator per fixed SRJ, boundary and rule set. A replacement plan
 * is checked against every other plan; no changed copper inherits cached checks.
 */
export function createFanoutPlanClearanceValidator(
  params: Omit<Parameters<typeof fanoutPlansAreClear>[0], "plans">,
): ((plans: readonly FanoutRoutePlan[]) => boolean) & {
  mutuallyClear(plans: readonly FanoutRoutePlan[]): boolean
} {
  const {
    srj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
    allowSameNetPlaneMerges = false,
  } = params
  const segmentCache: StaticPlanSegmentCache = {
    obstaclesByLayer: new Map(),
    byConnection: new Map(),
  }
  for (const obstacle of srj.obstacles)
    for (const layer of obstacle.layers) {
      const obstacles = segmentCache.obstaclesByLayer.get(layer) ?? []
      obstacles.push(obstacle)
      segmentCache.obstaclesByLayer.set(layer, obstacles)
    }
  // The same retained segment can appear in a plane or signal candidate.
  // Its static result must not cross those different merge permissions.
  const planeSegmentCache: StaticPlanSegmentCache =
    allowSameNetPlaneMerges && !allowSameNetMerges
      ? {
          obstaclesByLayer: segmentCache.obstaclesByLayer,
          byConnection: new Map(),
        }
      : segmentCache
  const segmentIndexes = new WeakMap<
    FanoutRoutePlan,
    RouteSegmentSpatialIndex
  >()
  const staticResults = new WeakMap<FanoutRoutePlan, boolean>()
  const mutualResults = new WeakMap<
    FanoutRoutePlan,
    WeakMap<FanoutRoutePlan, boolean>
  >()
  let lastClearPlans = new Set<FanoutRoutePlan>()
  const staticallyClear = (plan: FanoutRoutePlan): boolean => {
    let clear = staticResults.get(plan)
    if (clear === undefined) {
      clear = planIsStaticallyClear({
        segmentCache:
          plan.termination.type === "plane" ? planeSegmentCache : segmentCache,
        plan,
        srj,
        sharedBoundary,
        clearance,
        allowBlindAndBuriedVias,
        allowSameNetMerges:
          allowSameNetMerges ||
          (allowSameNetPlaneMerges && plan.termination.type === "plane"),
      })
      staticResults.set(plan, clear)
    }
    return clear
  }
  const clearOf = (plan: FanoutRoutePlan, other: FanoutRoutePlan): boolean => {
    let pairs = mutualResults.get(plan)
    if (!pairs) {
      pairs = new WeakMap()
      mutualResults.set(plan, pairs)
    }
    let clear = pairs.get(other)
    if (clear === undefined) {
      // Mutual copper clearance is symmetric, including both segment/via
      // directions. Query the smaller route against the larger route's index
      // instead of scanning every long meander beside a short source escape.
      // This path does not collect directional blockingBusCounts.
      const reverse =
        getPlanSegments(plan).length > getPlanSegments(other).length
      clear = planIsClearOfPlans({
        allowSameNetPlaneMerges,
        plan: reverse ? other : plan,
        otherPlans: [reverse ? plan : other],
        segmentIndexes,
        srj,
        clearance,
        allowSameNetMerges:
          allowSameNetMerges ||
          (allowSameNetPlaneMerges &&
            plan.termination.type === "plane" &&
            other.termination.type === "plane"),
      })
      pairs.set(other, clear)
      let opposite = mutualResults.get(other)
      if (!opposite) {
        opposite = new WeakMap()
        mutualResults.set(other, opposite)
      }
      opposite.set(plan, clear)
    }
    return clear
  }
  const validate = (plans: readonly FanoutRoutePlan[]): boolean => {
    const currentPlans = new Set(plans)
    if (currentPlans.size === plans.length) {
      // Retained immutable plans already form a clear set. Check each new
      // plan against the whole candidate in both directions; a failed
      // candidate never becomes the basis for a later validation.
      const changed = plans.filter((plan) => !lastClearPlans.has(plan))
      for (const plan of plans) {
        const retained = lastClearPlans.has(plan)
        if (!retained && !staticallyClear(plan)) return false
        // Keep the complete validator's directional check order. The order
        // matters for quickly rejecting a candidate beside dense copper.
        for (const other of retained ? changed : plans) {
          if (plan === other) continue
          if (!clearOf(plan, other)) return false
        }
      }
    } else {
      // Duplicate entries retain the original index-based self-checks.
      for (const [index, plan] of plans.entries()) {
        if (!staticallyClear(plan)) return false
        for (const [otherIndex, other] of plans.entries()) {
          if (otherIndex !== index && !clearOf(plan, other)) return false
        }
      }
    }
    lastClearPlans = currentPlans
    return true
  }
  return Object.assign(validate, {
    // Blocker discovery shares the exact route-pair checks and spatial indexes.
    // A mutual-only query cannot establish a statically clear baseline.
    mutuallyClear: (plans: readonly FanoutRoutePlan[]): boolean =>
      plans.every((plan, index) =>
        plans.every((other, otherIndex) =>
          otherIndex === index ? true : clearOf(plan, other),
        ),
      ),
  })
}
