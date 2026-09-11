import type { FanoutRoutePlan } from "./types"

/** Total constrained length represented by a fanout plan and its fixed prefix. */
export function getFanoutPlanEffectiveLength(plan: FanoutRoutePlan): number {
  return plan.length + (plan.lengthOffset ?? 0)
}

export function getFanoutPlanSkew(plans: readonly FanoutRoutePlan[]): number {
  const lengths = plans.map(getFanoutPlanEffectiveLength)
  return Math.max(...lengths) - Math.min(...lengths)
}
