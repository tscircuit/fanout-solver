import type { Point2D, PreparedConnection } from "../types"
import {
  directionSign,
  getAxis,
  getPerpendicularAxis,
  getPerpendicularPitch,
  makePoint,
} from "./directions"
import { getStraightOr45ConnectorVariants } from "./source-escape"
import type { RouteBusParams } from "./types"

export function getExpandedPlaneSourcePaths(
  connection: PreparedConnection,
  route: RouteBusParams,
): Point2D[][] {
  if (
    route.bus.termination.type !== "plane" ||
    route.bus.connections.length !== 1 ||
    connection.connection.pointsToConnect.length !== 1
  )
    return []
  const { direction } = route.bus
  const source = {
    x: connection.sourcePoint.x,
    y: connection.sourcePoint.y,
  }
  return [-1, 0, 1].flatMap((trackOffset) => {
    const site = makePoint({
      axis:
        getAxis(source, direction) +
        directionSign(direction) * route.viaDiameter,
      perpendicularAxis:
        getPerpendicularAxis(source, direction) +
        (trackOffset * getPerpendicularPitch(route.bus)) / 2,
      direction,
    })
    return getStraightOr45ConnectorVariants(source, site)
  })
}
