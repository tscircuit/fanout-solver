import type { FanoutSolverOptions, PreparedBus } from "./types"

const TOP_CENTER_PLANE_RESERVATION_BUS_IDS = [
  "U1_VSS_A1_DROP",
  "U1_VSS_A2_DROP",
  "U1_VSS_A4_DROP",
  "U1_VSS_A10_DROP",
  "U1_VSS_A13_DROP",
  "U1_VSS_A16_DROP",
  "U1_VSS_A19_DROP",
  "U1_VSS_A22_DROP",
  "U1_VSS_E6_DROP",
  "U1_VSS_F5_DROP",
  "U1_VSS_F6_DROP",
  "U1_VSS_G8_DROP",
  "U1_VSS_H1_DROP",
  "U1_VSS_H7_DROP",
  "U1_VSS_K8_DROP",
  "U1_VSS_L9_DROP",
  "U1_VSS_R1_DROP",
  "U1_VSS_T2_DROP",
  "U1_VSS_V3_DROP",
  "U1_VDDS_DDR_M7_DROP",
  "U1_VDDS_DDR_L8_DROP",
] as const

const TOP_CENTER_UNRESTRICTED_PLANE_BUS_IDS = [
  "U1_VSS_U7_DROP",
  "U1_VSS_R8_DROP",
  "U1_VSS_P9_DROP",
  "U1_VSS_N9_DROP",
  "U1_VSS_N11_DROP",
] as const

export interface DensePlaneRoutingHints {
  densePlaneReservationBusIds: readonly string[]
  denseUnrestrictedPlaneRoutingBusIds: readonly string[]
}

/**
 * Preserve the proven dense-plane choices for the raw AM62L top-center input.
 *
 * Older core/dataset captures predate the two explicit hint fields added by
 * the top-edge fix. Recognize the complete topology and its symmetric three-
 * band exit arrangement so those captures take the same bounded path. An
 * explicit empty array remains an opt-out, and no partial/similar fanout is
 * changed.
 */
export function inferDensePlaneRoutingHints(
  buses: readonly PreparedBus[],
  options: FanoutSolverOptions,
): DensePlaneRoutingHints | null {
  if (
    options.densePlaneReservationBusIds !== undefined ||
    options.denseUnrestrictedPlaneRoutingBusIds !== undefined
  ) {
    return null
  }

  const planeBuses = buses.filter((bus) => bus.termination.type === "plane")
  const boundaryBuses = buses.filter(
    (bus) => bus.termination.type === "boundary",
  )
  if (
    planeBuses.length !== 102 ||
    boundaryBuses.length !== 9 ||
    boundaryBuses.some((bus) => bus.exitEdge !== "top") ||
    boundaryBuses
      .map((bus) => bus.connections.length)
      .toSorted((a, b) => a - b)
      .join(",") !== "1,1,1,2,2,2,8,8,8"
  ) {
    return null
  }

  const boundaryBandCounts = new Map<string, number>()
  for (const bus of boundaryBuses) {
    const key = bus.preferredExit ?? ""
    boundaryBandCounts.set(key, (boundaryBandCounts.get(key) ?? 0) + 1)
  }
  if (
    boundaryBandCounts.get("top-left") !== 4 ||
    boundaryBandCounts.get("top") !== 2 ||
    boundaryBandCounts.get("top-right") !== 3
  ) {
    return null
  }

  const planeBusIds = new Set(planeBuses.map((bus) => bus.busId))
  const requiredBusIds = [
    ...TOP_CENTER_PLANE_RESERVATION_BUS_IDS,
    ...TOP_CENTER_UNRESTRICTED_PLANE_BUS_IDS,
  ]
  if (requiredBusIds.some((busId) => !planeBusIds.has(busId))) return null

  return {
    densePlaneReservationBusIds: TOP_CENTER_PLANE_RESERVATION_BUS_IDS,
    denseUnrestrictedPlaneRoutingBusIds: TOP_CENTER_UNRESTRICTED_PLANE_BUS_IDS,
  }
}
