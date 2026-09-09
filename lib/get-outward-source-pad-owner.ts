import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distance, distanceSegmentToObstacle } from "./geometry"
import type { Point2D } from "./types"
type Obstacle = SimpleRouteJson["obstacles"][number]

/** The source-pad exception applies only to an outward edge and its owner. */
export function getOutwardSourcePadOwner(
  start: Point2D,
  end: Point2D,
  layer: string,
  traceWidth: number,
  clearance: number,
  obstacle: Obstacle,
  source: { connectionName: string; sourcePoint: Point2D } | undefined,
): string | undefined {
  if (
    source &&
    layer === "top" &&
    distanceSegmentToObstacle(
      { start, end: start, width: traceWidth, layer },
      obstacle,
    ) <
      traceWidth / 2 + clearance - 1e-9 &&
    distance(end, source.sourcePoint) >=
      distance(start, source.sourcePoint) - 1e-9
  )
    return source.connectionName
  return undefined
}
