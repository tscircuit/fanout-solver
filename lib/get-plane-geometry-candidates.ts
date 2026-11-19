import { distance, pointIsInsideObstacle } from "./geometry"
import { getPlaneGeometryPaths } from "./get-plane-geometry-paths"
import { obstacleSharesElectricalNet } from "./net-identity"
import type { RouteBusParams } from "./route-bus"
import { directionSign, getAxis } from "./route-bus/directions"
import { routePlaneTerminatedBus } from "./route-bus/route-plane-terminated-bus"
import { chamferOrthogonalPolyline } from "./route-bus/source-escape"
import type { FanoutDirection, FanoutRoutePlan, Point2D } from "./types"

type PlaneLeadHeading = number

function getLeadDirection(
  lead: { start: Point2D; end: Point2D },
  preferred: FanoutDirection,
): FanoutDirection {
  const signedTravel =
    (getAxis(lead.end, preferred) - getAxis(lead.start, preferred)) *
    directionSign(preferred)
  if (signedTravel > 1e-9) return preferred
  const dx = lead.end.x - lead.start.x
  const dy = lead.end.y - lead.start.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right"
  return dy < 0 ? "down" : "up"
}

export function* getPlaneGeometryCandidates(
  route: RouteBusParams,
): Generator<FanoutRoutePlan> {
  route = {
    ...route,
    traceWidth: route.bus.singletonTraceWidth ?? route.traceWidth,
  }
  const { srj, bus, targetLayer, traceWidth, viaDiameter } = route
  const connection = bus.connections[0]!
  if (
    bus.termination.type !== "plane" ||
    bus.connections.length !== 1 ||
    connection.connection.pointsToConnect.length !== 1 ||
    bus.termination.layer !== targetLayer ||
    connection.sourceLayer === targetLayer ||
    route.fixedViaPointsByConnectionIndex ||
    route.sourceEscapePaths ||
    route.reservedVias?.length
  )
    return
  const planePours = srj.obstacles.filter(
    (obstacle) =>
      obstacle.isCopperPour && obstacle.layers.includes(targetLayer),
  )
  const sameNetPours = planePours.filter((obstacle) =>
    obstacleSharesElectricalNet(srj, obstacle, connection.connection.name),
  )
  const acceptedSites = new Map<PlaneLeadHeading, Point2D[]>()
  for (const path of getPlaneGeometryPaths(route)) {
    const site = path.at(-1)!
    const landsOnPlane =
      planePours.length === 0 ||
      sameNetPours.some((pour) => pointIsInsideObstacle(site, pour))
    if (!landsOnPlane) continue
    const source = connection.sourcePoint
    const first = path[1]!
    const heading = Math.round(
      Math.atan2(first.y - source.y, first.x - source.x) / (Math.PI / 4),
    )
    const nearby = acceptedSites.get(heading) ?? []
    if (nearby.some((point) => distance(point, site) < viaDiameter / 2))
      continue
    const sourceEscapePath = chamferOrthogonalPolyline(path, traceWidth / 2)
    const exit = sourceEscapePath.findIndex(
      (point) => !pointIsInsideObstacle(point, connection.sourceObstacle),
    )
    if (exit < 1) continue
    const lead = {
      start: sourceEscapePath[exit - 1]!,
      end: sourceEscapePath[exit]!,
    }
    const direction = getLeadDirection(
      lead,
      bus.requestedDirection ?? bus.direction,
    )
    if (bus.requestedDirection && direction !== bus.requestedDirection) continue
    const plans = routePlaneTerminatedBus({
      ...route,
      bus: direction === bus.direction ? bus : { ...bus, direction },
      staticClearanceCache: undefined,
      fixedViaPointsByConnectionIndex: new Map([
        [connection.connectionIndex, site],
      ]),
      sourceEscapePaths: new Map([
        [connection.connectionIndex, sourceEscapePath],
      ]),
    })
    if (!plans) continue
    if (plans.length !== 1)
      throw new Error("Expected one geometric plane escape")
    nearby.push(site)
    acceptedSites.set(heading, nearby)
    yield plans[0]!
  }
}
