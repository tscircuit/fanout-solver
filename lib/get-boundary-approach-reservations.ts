import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { Point2D, PreparedBus } from "./types"

/**
 * Keep the first trace pitch of later exits available while choosing through
 * vias for an earlier group. These traces are temporary search reservations;
 * the caller retains the original input and emits only its routed connections.
 */
export function getBoundaryApproachReservations(params: {
  buses: readonly PreparedBus[]
  excludedBusIds: ReadonlySet<string>
  exits: ReadonlyMap<number, Point2D>
  targetLayerByBusId: ReadonlyMap<string, string>
  traceWidth: number
  clearance: number
}): NonNullable<SimpleRouteJson["traces"]> {
  const length = params.traceWidth + params.clearance
  if (
    !Number.isFinite(length) ||
    !(params.traceWidth > 0) ||
    params.clearance < 0
  )
    throw new Error("Boundary approach reservations require valid trace rules")
  return params.buses
    .filter(
      (bus) =>
        bus.termination.type === "boundary" &&
        !params.excludedBusIds.has(bus.busId),
    )
    .flatMap((bus) => {
      const layer = params.targetLayerByBusId.get(bus.busId)
      if (!layer || !bus.exitEdge)
        throw new Error(
          `Missing boundary approach layer or edge for ${bus.busId}`,
        )
      return bus.connections.map((connection) => {
        const end = params.exits.get(connection.connectionIndex)
        if (!end)
          throw new Error(
            `Missing boundary approach target for ${connection.connectionIndex}`,
          )
        const start = { ...end }
        if (bus.exitEdge === "bottom") start.y += length
        else if (bus.exitEdge === "top") start.y -= length
        else if (bus.exitEdge === "left") start.x += length
        else start.x -= length
        return {
          type: "pcb_trace" as const,
          pcb_trace_id: `fanout-approach-reservation:${connection.connectionIndex}`,
          connection_name: connection.connection.name,
          route: [start, end].map((point) => ({
            route_type: "wire" as const,
            ...point,
            layer,
            width: params.traceWidth,
          })),
        }
      })
    })
}
