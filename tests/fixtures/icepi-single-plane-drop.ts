import type { RouteBusParams } from "lib/route-bus"
import type { FanoutSolverOptions } from "lib/types"
import { createIcepiPlaneDrop } from "./icepi-plane-drop"

/** Select one native bus without changing regional geometry or physical rules. */
export function createIcepiSinglePlaneDrop(): {
  routeParams: RouteBusParams
  solverOptions: FanoutSolverOptions
} {
  const captured = createIcepiPlaneDrop()
  const srj = {
    ...captured.srj,
    connections: [captured.bus.connections[0].connection],
    buses: captured.srj.buses?.filter(
      (bus) => bus.busId === captured.bus.busId,
    ),
  }
  return {
    routeParams: { ...captured, srj },
    solverOptions: {
      buses: srj.buses,
      busDirections: { [captured.bus.busId]: captured.bus.direction },
      sharedBoundary: captured.bus.sharedBoundary,
      escapeLayers: captured.layerNames,
      traceWidth: captured.traceWidth,
      viaDiameter: captured.viaDiameter,
      viaHoleDiameter: captured.viaHoleDiameter,
      clearance: captured.clearance,
      compactBusTracks: captured.compactBusTracks,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    },
  }
}
