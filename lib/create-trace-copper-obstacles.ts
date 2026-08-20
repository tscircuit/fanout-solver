import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { distance } from "./geometry"
import { getCopperLayerNames, getLayerSpan } from "./layer-names"

const EPSILON = 1e-9

export function createTraceCopperObstacles(srj: SimpleRouteJson): Obstacle[] {
  const layerNames = getCopperLayerNames(srj.layerCount)
  const obstacles: Obstacle[] = []

  for (const trace of srj.traces ?? []) {
    let previousWire:
      | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
      | undefined

    for (const point of trace.route) {
      if (point.route_type === "via") {
        obstacles.push({
          obstacleId: `trace-copper:${trace.pcb_trace_id}:via:${obstacles.length}`,
          type: "rect",
          center: { x: point.x, y: point.y },
          width: point.via_diameter ?? srj.minViaPadDiameter ?? 0.3,
          height: point.via_diameter ?? srj.minViaPadDiameter ?? 0.3,
          layers: getLayerSpan(point.from_layer, point.to_layer, layerNames),
          connectedTo: [trace.connection_name],
        })
        previousWire = undefined
        continue
      }
      if (point.route_type !== "wire") {
        previousWire = undefined
        continue
      }
      if (previousWire?.layer === point.layer) {
        const segmentLength = distance(previousWire, point)
        if (segmentLength > EPSILON) {
          obstacles.push({
            obstacleId: `trace-copper:${trace.pcb_trace_id}:segment:${obstacles.length}`,
            type: "rect",
            center: {
              x: (previousWire.x + point.x) / 2,
              y: (previousWire.y + point.y) / 2,
            },
            width: segmentLength,
            height: Math.max(previousWire.width, point.width),
            ccwRotationDegrees:
              (Math.atan2(point.y - previousWire.y, point.x - previousWire.x) *
                180) /
              Math.PI,
            layers: [point.layer],
            connectedTo: [trace.connection_name],
          })
        }
      }
      previousWire = point
    }
  }

  return obstacles
}
