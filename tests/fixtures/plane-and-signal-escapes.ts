import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"

const bounds = { minX: -1.1, maxX: 1.7, minY: -1.1, maxY: 1.1 }

export function createPlaneAndSignalEscapes() {
  const pads = [
    { name: "GND", x: 0, y: 0 },
    { name: "DQ", x: 0.6, y: 0 },
    { name: "NC1", x: 0, y: -0.6 },
    { name: "NC2", x: 0.6, y: -0.6 },
  ]
  const source = (pad: (typeof pads)[number]) => ({
    x: pad.x,
    y: pad.y,
    layer: "top",
    pointId: pad.name,
    pcb_port_id: pad.name,
  })
  const input: SimpleRouteJson & { allowViaInPad: boolean } = {
    bounds,
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.12,
    minTraceToPadEdgeClearance: 0.075,
    minViaEdgeToPadEdgeClearance: 0.075,
    allowViaInPad: false,
    connections: [
      { name: "GND", pointsToConnect: [source(pads[0]!)] },
      {
        name: "DQ",
        pointsToConnect: [source(pads[1]!), { x: -2, y: 0, layer: "bottom" }],
      },
    ],
    obstacles: [
      ...pads.map((pad) => ({
        type: "rect" as const,
        shape: "circle",
        componentId: "U1",
        obstacleId: `pad-${pad.name}`,
        center: { x: pad.x, y: pad.y },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: [pad.name],
      })),
    ],
  }
  const options: FanoutSolverOptions = {
    sharedBoundary: bounds,
    sourceComponentId: "U1",
    allowBlindAndBuriedVias: false,
    escapeLayers: ["bottom"],
    buses: [
      {
        busId: "ground",
        connectionNames: ["GND"],
        direction: "left",
        termination: { type: "plane", layer: "inner1" },
      },
      {
        busId: "signal",
        connectionNames: ["DQ"],
        direction: "left",
        preferredExit: "left",
        allowedLayers: ["bottom"],
      },
    ],
  }
  return { input, options }
}
