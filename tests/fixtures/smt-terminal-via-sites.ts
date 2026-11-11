import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { PreparedBus, PreparedConnection } from "../../lib/types"
export function createSmtTerminalViaSiteFixture() {
  const obstacles: Obstacle[] = [0, 1].flatMap((column) =>
    [0, 0.5, 1, 1.5].map((y, row) => ({
      type: "rect",
      obstacleId: `pad-${column}-${row}`,
      componentId: "U1",
      center: { x: column ? 5.800852 + (row === 2 ? 0.00127 : 0) : 0, y },
      width: 1.3,
      height: 0.3,
      layers: ["top"],
      connectedTo: [
        column && row === 0 ? "P" : column && row === 2 ? "N" : "GND",
      ],
    })),
  )
  const connections: PreparedConnection[] = [4, 6].map((index, i) => {
    const source = obstacles[index],
      point = { ...source.center, layer: "top" }
    return {
      connectionIndex: i,
      connection: { name: i ? "N" : "P", pointsToConnect: [point] },
      sourcePoint: point,
      sourcePointIndex: 0,
      sourceLayer: "top",
      sourceObstacle: source,
      targetPoint: point,
    }
  })
  const bus: PreparedBus = {
    busId: "SMT",
    componentId: "U1",
    direction: "down",
    termination: { type: "plane", layer: "bottom" },
    componentObstacles: obstacles,
    componentBounds: { minX: 0, maxX: 5.802122, minY: 0, maxY: 1.5 },
    sharedBoundary: { minX: -2, maxX: 8, minY: -2, maxY: 4 },
    xCoordinates: [0, 5.800852, 5.802122],
    yCoordinates: [0, 0.5, 1, 1.5],
    pitchX: 0.00127,
    pitchY: 0.5,
    connections,
  }
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.5,
    minViaHoleDiameter: 0.3,
    minTraceToPadEdgeClearance: 0.1,
    allowBlindAndBuriedVias: false,
    allowViaInPad: false,
    bounds: bus.sharedBoundary,
    obstacles,
    connections: connections.map((c) => c.connection),
  }
  const rules = {
    viaDiameter: 0.5,
    viaHoleDiameter: 0.3,
    traceWidth: 0.1,
    clearance: 0.1,
    holeToHoleClearance: 0.2,
    additionalObstacles: obstacles,
  }
  return { bus, input, rules }
}
