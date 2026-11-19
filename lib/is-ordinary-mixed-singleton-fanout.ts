import type { PreparedBus } from "./types"

export function isOrdinaryMixedSingletonFanout(params: {
  buses: readonly PreparedBus[]
  densePlaneReservationBusIds: readonly string[]
  denseUnrestrictedPlaneRoutingBusIds: readonly string[]
}): boolean {
  const { buses, densePlaneReservationBusIds, denseUnrestrictedPlaneRoutingBusIds } = params
  return (
    densePlaneReservationBusIds.length === 0 &&
    denseUnrestrictedPlaneRoutingBusIds.length === 0 &&
    buses.every((bus) => bus.connections.length === 1) &&
    buses.some((bus) => bus.termination.type === "plane") &&
    buses.some((bus) => bus.termination.type === "boundary")
  )
}
