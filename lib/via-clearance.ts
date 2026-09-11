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

export function getViaPairMinimumHoleCenterDistance(params: {
  first: Pick<ViaDimensions, "holeDiameter">
  second: Pick<ViaDimensions, "holeDiameter">
  holeToHoleClearance: number
}): number {
  const { first, second, holeToHoleClearance } = params
  return (first.holeDiameter + second.holeDiameter) / 2 + holeToHoleClearance
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
    getViaPairMinimumHoleCenterDistance({
      first,
      second,
      holeToHoleClearance,
    }),
  )
}
