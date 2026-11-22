import { connectionsShareElectricalNet } from "../net-identity"
import type { PreparedConnection, RoutedVia } from "../types"
import { pointIsInsideBounds } from "./directions"
import { getPlanVias } from "./plan-copper"
import type { RouteBusParams } from "./types"

export function getExistingPlaneVias(
  params: RouteBusParams,
  connection: PreparedConnection,
): RoutedVia[] {
  const vias: RoutedVia[] = []
  for (const plan of params.acceptedPlans) {
    if (
      plan.termination.type !== "plane" ||
      plan.termination.layer !== params.targetLayer ||
      !connectionsShareElectricalNet(
        params.srj,
        connection.connection.name,
        plan.connectionName,
      )
    ) {
      continue
    }
    for (const via of getPlanVias(plan)) {
      const terminatesOnPlane =
        via.fromLayer === params.targetLayer ||
        via.toLayer === params.targetLayer
      if (
        terminatesOnPlane &&
        via.spanLayers.includes(connection.sourceLayer) &&
        pointIsInsideBounds(via.center, params.bus.sharedBoundary)
      ) {
        vias.push(via)
      }
    }
  }
  return vias
}
