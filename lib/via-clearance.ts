import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

export interface ViaDimensions {
  diameter: number
  holeDiameter: number
}

export function getViaHoleToHoleClearance(
  srj: SimpleRouteJson,
  copperClearance: number,
): number {
  return (
    (
      srj as SimpleRouteJson & {
        minViaHoleEdgeToViaHoleEdgeClearance?: number
      }
    ).minViaHoleEdgeToViaHoleEdgeClearance ?? copperClearance
  )
}

export function getViaPairMinimumCenterDistance(params: {
  first: ViaDimensions
  second: ViaDimensions
  copperClearance: number
  holeToHoleClearance: number
}): number {
  const { first, second, copperClearance, holeToHoleClearance } = params
  return Math.max(
    (first.diameter + second.diameter) / 2 + copperClearance,
    (first.holeDiameter + second.holeDiameter) / 2 + holeToHoleClearance,
  )
}
