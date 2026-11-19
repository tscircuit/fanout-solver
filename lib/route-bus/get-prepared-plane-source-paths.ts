import type { Point2D, PreparedConnection } from "../types"
import { getPlaneSourceEscapePaths } from "./get-plane-source-escape-paths"
import type {
  BuildPlanParams,
  PlanClearanceKey,
  RouteBusParams,
} from "./types"

export interface PreparedPlaneSourcePaths {
  sourceEscapePaths: readonly (readonly Point2D[])[]
  connectionCacheKeyPrefix: PlanClearanceKey
  pathCacheKeyPrefixes: PlanClearanceKey[]
}

export function getPreparedPlaneSourcePaths(
  {
    preparedConnection,
    viaHandedness,
    sourcePathsByConnection,
  }: Pick<BuildPlanParams, "preparedConnection" | "viaHandedness"> & {
    sourcePathsByConnection: Map<PreparedConnection, PreparedPlaneSourcePaths>
  },
  routeParams: RouteBusParams,
): PreparedPlaneSourcePaths {
  const cached = sourcePathsByConnection.get(preparedConnection)
  if (cached) return cached
  const { bus, targetLayer } = routeParams
  const prepared: PreparedPlaneSourcePaths = {
    sourceEscapePaths: getPlaneSourceEscapePaths(
      { preparedConnection, viaHandedness },
      routeParams,
    ),
    connectionCacheKeyPrefix: `plane:${bus.busId}:${targetLayer}:${bus.direction}:${preparedConnection.connectionIndex}:${viaHandedness}`,
    pathCacheKeyPrefixes: [],
  }
  sourcePathsByConnection.set(preparedConnection, prepared)
  return prepared
}
