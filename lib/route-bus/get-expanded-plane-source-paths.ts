import type { Point2D, PreparedConnection } from "../types"
import { getPlaneGeometrySourcePaths } from "./get-plane-geometry-source-paths"
import {
  directionSign,
  getAxis,
  getPerpendicularAxis,
  getPerpendicularPitch,
  makePoint,
} from "./directions"
import { getStraightOr45ConnectorVariants } from "./source-escape"
import type { RouteBusParams } from "./types"

export function* getExpandedPlaneSourcePaths(
  connection: PreparedConnection,
  route: RouteBusParams,
): Generator<Point2D[]> {
  if (
    route.bus.termination.type !== "plane" ||
    route.bus.connections.length !== 1 ||
    connection.connection.pointsToConnect.length !== 1
  )
    return
  const { direction } = route.bus
  const source = {
    x: connection.sourcePoint.x,
    y: connection.sourcePoint.y,
  }
  for (const trackOffset of [-1, 0, 1]) {
    const site = makePoint({
      axis:
        getAxis(source, direction) + directionSign(direction) * route.viaDiameter,
      perpendicularAxis:
        getPerpendicularAxis(source, direction) +
        (trackOffset * getPerpendicularPitch(route.bus)) / 2,
      direction,
    })
    yield* getStraightOr45ConnectorVariants(source, site)
  }
  yield* getPlaneGeometrySourcePaths(connection, route)
}
