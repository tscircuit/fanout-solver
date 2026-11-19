import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"

const bounds = { minX: -1.1, maxX: 1.7, minY: -1.1, maxY: 1.1 }

function innerCopper(x1: number, x2: number, y1: number, y2: number): Obstacle {
  return {
    type: "rect",
    layers: ["inner2"],
    center: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
    width: x2 - x1,
    height: y2 - y1,
    connectedTo: ["foreign-copper"],
  }
}

export function createTwoViaWindows() {
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
      // The through-vias have just two windows in the foreign inner2 copper,
      // centered at (−0.235, 0.30) and (0.30, 0) mm.
      innerCopper(-1.1, 1.7, -1.1, -0.21),
      innerCopper(-1.1, 1.7, 0.51, 1.1),
      innerCopper(-1.1, -0.45, -0.21, 0.51),
      innerCopper(-0.02, 0.09, -0.21, 0.51),
      innerCopper(0.51, 1.7, -0.21, 0.51),
      innerCopper(-0.45, -0.02, -0.21, 0.09),
      innerCopper(0.09, 0.51, 0.21, 0.51),
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
