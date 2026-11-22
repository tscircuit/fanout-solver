import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { validateRoutedCopperDrc } from "../../lib/index"

// Geometry stays fixed while an editor splits or merges electrical nets.
export function createCrossingTraces(): SimpleRouteJson {
  const endpoints = [
    [
      { x: -2, y: 0 },
      { x: 2, y: 0 },
    ],
    [
      { x: 0, y: -2 },
      { x: 0, y: 2 },
    ],
  ]
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    obstacles: [],
    connections: endpoints.map((points, i) => ({
      name: i === 0 ? "A" : "B",
      netConnectionName: "COMMON",
      pointsToConnect: points.map((point, j) => ({
        ...point,
        layer: "top",
        pcb_port_id: `port_${i}_${j}`,
      })),
    })),
    traces: endpoints.map((points, i) => ({
      type: "pcb_trace",
      pcb_trace_id: `trace_${i}`,
      connection_name: i === 0 ? "A" : "B",
      route: points.map((point) => ({
        ...point,
        route_type: "wire",
        layer: "top",
        width: 0.1,
      })),
    })),
  }
}

export function audit(scene: SimpleRouteJson) {
  return validateRoutedCopperDrc({
    inputSrj: scene,
    routedSrj: scene,
    clearance: 0.1,
  })
}

if (import.meta.main) {
  const scene = createCrossingTraces()
  const sharedNet = audit(scene)
  for (const connection of scene.connections) {
    connection.netConnectionName = connection.name
  }
  console.log(
    JSON.stringify(
      {
        sharedNet,
        splitNetsSameObject: audit(scene),
        splitNetsFreshObject: audit(structuredClone(scene)),
      },
      null,
      2,
    ),
  )
}
