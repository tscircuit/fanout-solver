import { getDirectionForExitEdge } from "./boundary-exit"
import { getBoundaryTargetTrack } from "./route-bus"
import type { PreparedBus } from "./types"

const minimumJointBoundaryBusCount = 5
const maximumJointBoundaryBusCount = 40
const maximumJointBoundaryConnectionCount = 64
const minimumLargeBoundaryOnlyBusCount = 10
const minimumMixedRoutingPlaneBusCount = 8

export type DenseBoundaryRoutingMode =
  | "mixed_with_planes"
  | "large_boundary_only"

export function shouldUseJointBoundaryViaReservation(
  boundaryBusConnectionCounts: readonly number[],
): boolean {
  const boundaryBusCount = boundaryBusConnectionCounts.length
  const boundaryConnectionCount = boundaryBusConnectionCounts.reduce(
    (sum, count) => sum + count,
    0,
  )
  return (
    (boundaryBusCount >= minimumJointBoundaryBusCount &&
      boundaryBusCount <= maximumJointBoundaryBusCount &&
      boundaryConnectionCount <= maximumJointBoundaryConnectionCount) ||
    (boundaryBusCount === 4 && new Set(boundaryBusConnectionCounts).size > 1)
  )
}

export function getDenseBoundaryRoutingMode({
  boundaryBusConnectionCounts,
  planeBusCount,
}: {
  boundaryBusConnectionCounts: readonly number[]
  planeBusCount: number
}): DenseBoundaryRoutingMode | null {
  const boundaryBusCount = boundaryBusConnectionCounts.length
  if (
    boundaryBusCount <= minimumLargeBoundaryOnlyBusCount - 1 &&
    planeBusCount >= minimumMixedRoutingPlaneBusCount
  ) {
    return "mixed_with_planes"
  }
  if (
    boundaryBusCount >= minimumLargeBoundaryOnlyBusCount &&
    planeBusCount === 0 &&
    shouldUseJointBoundaryViaReservation(boundaryBusConnectionCounts)
  ) {
    return "large_boundary_only"
  }
  return null
}

function getAverageBusBoundaryTargetTrack(bus: PreparedBus): number {
  if (!bus.exitEdge) {
    throw new Error(
      `Cannot order boundary bus ${bus.busId} without an exit edge`,
    )
  }
  const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
  return (
    bus.connections.reduce(
      (sum, connection) =>
        sum + getBoundaryTargetTrack({ bus, connection, boundaryDirection }),
      0,
    ) / bus.connections.length
  )
}

export function orderDenseBoundaryBusesForRouting({
  busesInRoutingOrder,
  busLayerAssignments,
  routingMode,
}: {
  busesInRoutingOrder: readonly PreparedBus[]
  busLayerAssignments: Readonly<Record<string, string>>
  routingMode: DenseBoundaryRoutingMode
}): PreparedBus[] {
  if (routingMode !== "large_boundary_only") return [...busesInRoutingOrder]

  const singletonBuses = busesInRoutingOrder.filter(
    (bus) => bus.connections.length === 1,
  )
  if (new Set(singletonBuses.map((bus) => bus.exitEdge)).size !== 1) {
    return [...busesInRoutingOrder]
  }

  // Vias on the same target layer cannot exchange boundary order after
  // leaving the package. Give wide fields first choice, then sweep each
  // singleton layer in physical target order to avoid trapped channels.
  const nonSingletonBuses = [
    ...busesInRoutingOrder
      .filter((bus) => bus.connections.length >= 8)
      .toSorted(
        (first, second) =>
          getAverageBusBoundaryTargetTrack(second) -
          getAverageBusBoundaryTargetTrack(first),
      ),
    ...busesInRoutingOrder.filter(
      (bus) => bus.connections.length > 1 && bus.connections.length < 8,
    ),
  ]
  const singletonLayerGroups: Array<{
    targetLayer: string
    buses: PreparedBus[]
  }> = []
  for (const bus of singletonBuses) {
    const targetLayer = busLayerAssignments[bus.busId]
    if (!targetLayer) {
      throw new Error(`Cannot order boundary bus ${bus.busId} without a layer`)
    }
    let singletonLayerGroup = singletonLayerGroups.find(
      (candidate) => candidate.targetLayer === targetLayer,
    )
    if (!singletonLayerGroup) {
      singletonLayerGroup = { targetLayer, buses: [] }
      singletonLayerGroups.push(singletonLayerGroup)
    }
    singletonLayerGroup.buses.push(bus)
  }

  return [
    ...nonSingletonBuses,
    ...singletonLayerGroups.flatMap((singletonLayerGroup) =>
      singletonLayerGroup.buses.toSorted(
        (first, second) =>
          getAverageBusBoundaryTargetTrack(second) -
          getAverageBusBoundaryTargetTrack(first),
      ),
    ),
  ]
}
