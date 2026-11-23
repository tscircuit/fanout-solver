import { getExitEdgeForDirection } from "../boundary-exit"
import { distance } from "../geometry"
import { routeViaMinimalWindingAlternativesSteps } from "../route-via-minimal-winding"
import type { FanoutRoutePlan, PreparedConnection } from "../types"
import { getExistingPlaneVias } from "./get-existing-plane-vias"
import { routePlaneTerminatedBus } from "./route-plane-terminated-bus"
import type { RouteBusParams } from "./types"

/** Join an owned plane via on the source layer in board-world millimetres. */
export function getWindingPlaneViaReuseAlternative(
  params: RouteBusParams,
  connection: PreparedConnection,
): FanoutRoutePlan | undefined {
  const vias = getExistingPlaneVias(params, connection).toSorted(
    (first, second) =>
      distance(connection.sourcePoint, first.center) -
      distance(connection.sourcePoint, second.center),
  )
  for (const via of vias) {
    const steps = routeViaMinimalWindingAlternativesSteps({
      ...params,
      bus: {
        ...params.bus,
        exitEdge:
          params.bus.exitEdge ?? getExitEdgeForDirection(params.bus.direction),
      },
      targetLayer: connection.sourceLayer,
      terminals: [
        { connection, viaPoint: connection.sourcePoint, exitPoint: via.center },
      ],
      allowSourceLayerRouting: true,
      allowSameNetMerges: true,
      gridStepDivisor: 2,
      alignGridToPads: true,
      maximumRouteOrderAttempts: 1,
    })
    let result = steps.next()
    while (!result.done) result = steps.next()
    const windingPlan = result.value[0]?.[0]
    if (!windingPlan) continue
    const path = [
      connection.sourcePoint,
      ...windingPlan.segments.map((segment) => segment.end),
    ]
    const plan = routePlaneTerminatedBus({
      ...params,
      bus: { ...params.bus, connections: [connection] },
      fixedViaPointsByConnectionIndex: new Map([
        [connection.connectionIndex, via.center],
      ]),
      sourceEscapePaths: new Map([[connection.connectionIndex, path]]),
      staticClearanceCache: undefined,
    })?.[0]
    if (plan && !plan.via) return plan
  }
  return undefined
}
