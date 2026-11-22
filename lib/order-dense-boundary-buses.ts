import { getDirectionForExitEdge } from "./boundary-exit"
import { getBoundaryTargetTrack } from "./route-bus"
import type { PreparedBus } from "./types"

function getAverageBoundaryTargetTrack(bus: PreparedBus): number {
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

/**
 * Route atomic multi-connection buses before single-connection buses. Within
 * each equally sized multi-connection field, and within each singleton
 * edge/layer corridor, preserve the physical target order so an earlier route
 * cannot trap a later route behind its through-vias.
 */
export function orderDenseBoundaryBuses(params: {
  busesInRoutingOrder: readonly PreparedBus[]
  busLayerAssignments: Readonly<Record<string, string>>
}): PreparedBus[] {
  const multiConnectionBuses = params.busesInRoutingOrder
    .filter((bus) => bus.connections.length > 1)
    .toSorted(
      (first, second) =>
        second.connections.length - first.connections.length ||
        getAverageBoundaryTargetTrack(second) -
          getAverageBoundaryTargetTrack(first),
    )
  const singletonGroups: Array<{
    exitEdge: PreparedBus["exitEdge"]
    targetLayer: string
    buses: PreparedBus[]
  }> = []
  for (const bus of params.busesInRoutingOrder) {
    if (bus.connections.length !== 1) continue
    const targetLayer = params.busLayerAssignments[bus.busId]
    if (!targetLayer) {
      throw new Error(`Cannot order boundary bus ${bus.busId} without a layer`)
    }
    let singletonGroup = singletonGroups.find(
      (candidate) =>
        candidate.exitEdge === bus.exitEdge &&
        candidate.targetLayer === targetLayer,
    )
    if (!singletonGroup) {
      singletonGroup = { exitEdge: bus.exitEdge, targetLayer, buses: [] }
      singletonGroups.push(singletonGroup)
    }
    singletonGroup.buses.push(bus)
  }

  return [
    ...multiConnectionBuses,
    ...singletonGroups.flatMap((singletonGroup) =>
      singletonGroup.buses.toSorted(
        (first, second) =>
          getAverageBoundaryTargetTrack(second) -
          getAverageBoundaryTargetTrack(first),
      ),
    ),
  ]
}
