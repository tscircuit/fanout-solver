import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"

export interface ViaDimensions {
  diameter: number
  holeDiameter: number
}

export function getViaHoleToHoleClearance(srj: SimpleRouteJson): number {
  return (
    (
      srj as SimpleRouteJson & {
        minViaHoleEdgeToViaHoleEdgeClearance?: number
      }
    ).minViaHoleEdgeToViaHoleEdgeClearance ?? 0
  )
}

/** Same-net routes can serialize one physical drilled hole more than once. */
export function viaCentersRepresentSamePhysicalHole(
  first: { x: number; y: number },
  second: { x: number; y: number },
  epsilon = 1e-9,
): boolean {
  return Math.hypot(first.x - second.x, first.y - second.y) <= epsilon
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
