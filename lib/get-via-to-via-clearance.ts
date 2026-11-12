import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"

/** Copper spacing is independent of the via-to-pad and drill-hole rules. */
export function getViaToViaClearance(
  srj: SimpleRouteJson,
  clearance: number,
): number {
  const minimum = (
    srj as SimpleRouteJson & { minPadEdgeToPadEdgeClearance?: number }
  ).minPadEdgeToPadEdgeClearance
  if (minimum === undefined) return clearance
  if (!Number.isFinite(minimum) || minimum < 0) {
    throw new Error(
      `FanoutSolver: minPadEdgeToPadEdgeClearance must be a non-negative finite number, received ${minimum}`,
    )
  }
  return Math.max(clearance, minimum)
}

export function getViaToObstacleClearance(params: {
  obstacle: Obstacle
  clearance: number
  viaToViaClearance: number
}): number {
  const { obstacle, clearance, viaToViaClearance } = params
  return (
    obstacle as Obstacle & { circuitJsonMetadata?: { pcb_via_id?: string } }
  ).circuitJsonMetadata?.pcb_via_id !== undefined
    ? viaToViaClearance
    : clearance
}
