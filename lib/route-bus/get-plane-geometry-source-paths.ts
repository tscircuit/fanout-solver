import { pointIsInsideObstacle } from "../geometry"
import { getPlaneGeometryPaths } from "../get-plane-geometry-paths"
import { obstacleSharesElectricalNet } from "../net-identity"
import type { Point2D, PreparedConnection } from "../types"
import { directionSign, getAxis } from "./directions"
import { chamferOrthogonalPolyline } from "./source-escape"
import type { RouteBusParams } from "./types"

/** Propose source paths; the ordinary plane planner builds and validates them. */
export function* getPlaneGeometrySourcePaths(
  connection: PreparedConnection,
  route: RouteBusParams,
): Generator<Point2D[]> {
  const { srj, bus, targetLayer, traceWidth } = route
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
    (obstacle) => obstacle.isCopperPour && obstacle.layers.includes(targetLayer),
  )
  const sameNetPours = planePours.filter((obstacle) =>
    obstacleSharesElectricalNet(srj, obstacle, connection.connection.name),
  )
  for (const path of getPlaneGeometryPaths(route)) {
    const site = path.at(-1)!
    if (
      planePours.length > 0 &&
      !sameNetPours.some((pour) => pointIsInsideObstacle(site, pour))
    )
      continue
    const sourceEscapePath = chamferOrthogonalPolyline(path, traceWidth / 2)
    const exit = sourceEscapePath.findIndex(
      (point) => !pointIsInsideObstacle(point, connection.sourceObstacle),
    )
    if (exit < 1) continue
    const signedTravel =
      (getAxis(sourceEscapePath[exit]!, bus.direction) -
        getAxis(sourceEscapePath[exit - 1]!, bus.direction)) *
      directionSign(bus.direction)
    if (signedTravel > 1e-9) yield sourceEscapePath
  }
}
