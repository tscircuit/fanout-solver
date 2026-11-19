import { distance, pointIsInsideObstacle } from "../geometry"
import {
  getLocalPlaneEscapePaths,
  getPlaneEscapeDirection,
} from "../get-local-plane-escape-paths"
import type { FanoutRoutePlan } from "../types"
import { routePlaneTerminatedBus } from "./route-plane-terminated-bus"
import { chamferOrthogonalPolyline } from "./source-escape"
import type { RouteBusParams } from "./types"

/** Additional local plane drops for mixed-bus recovery. Each returned plan is
 * an alternative for the same pad, checked against the caller's existing copper. */
export function* getLocalPlaneEscapeCandidates(
  params: RouteBusParams,
): Generator<FanoutRoutePlan> {
  const { bus, targetLayer } = params
  const requiredLeadDirection = bus.requestedDirection
  const [preparedConnection] = bus.connections
  if (
    !bus.acceptsPlaneEscape ||
    bus.connections.length !== 1 ||
    !preparedConnection ||
    bus.termination.type !== "plane" ||
    bus.termination.layer !== targetLayer ||
    preparedConnection.sourceLayer === targetLayer ||
    params.fixedViaPointsByConnectionIndex ||
    params.sourceEscapePaths ||
    params.reservedVias?.length
  )
    return

  const traceWidth = bus.singletonTraceWidth ?? params.traceWidth
  const acceptedSites = new Map<number, { x: number; y: number }[]>()
  for (const { path, checkWire } of getLocalPlaneEscapePaths(params, {
    connection: preparedConnection,
    traceWidth,
    requiredLeadDirection,
  })) {
    const site = path.at(-1)!
    const source = preparedConnection.sourcePoint
    const first = path[1]!
    const heading = Math.round(
      Math.atan2(first.y - source.y, first.x - source.x) / (Math.PI / 4),
    )
    const nearby = acceptedSites.get(heading) ?? []
    if (nearby.some((point) => distance(point, site) < params.viaDiameter / 2))
      continue
    if (path.length > 2 && !checkWire(first, site)) continue
    const sourceEscapePath = chamferOrthogonalPolyline(path, traceWidth / 2)
    const exit = sourceEscapePath.findIndex(
      (point) =>
        !pointIsInsideObstacle(point, preparedConnection.sourceObstacle),
    )
    if (exit <= 0) continue
    const direction = getPlaneEscapeDirection(
      { start: sourceEscapePath[exit - 1]!, end: sourceEscapePath[exit]! },
      requiredLeadDirection ?? bus.direction,
    )
    if (requiredLeadDirection && direction !== requiredLeadDirection) continue
    const directionalBus =
      direction === bus.direction ? bus : { ...bus, direction }
    // Different paths can reach the same site. The fixed-site cache identifies
    // only the via, so check this proposed path against the actual copper.
    const [plan] =
      routePlaneTerminatedBus({
        ...params,
        bus: directionalBus,
        traceWidth,
        staticClearanceCache: undefined,
        fixedViaPointsByConnectionIndex: new Map([
          [preparedConnection.connectionIndex, site],
        ]),
        sourceEscapePaths: new Map([
          [preparedConnection.connectionIndex, sourceEscapePath],
        ]),
      }) ?? []
    if (!plan) continue
    nearby.push(site)
    acceptedSites.set(heading, nearby)
    yield plan
  }
}
