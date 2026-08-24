import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutBusSpec } from "lib/types"

export function createSingleSignalFanoutFixture(
  busOverrides: Partial<FanoutBusSpec> = {},
): { simpleRouteJson: SimpleRouteJson; bus: FanoutBusSpec } {
  const coordinates = [-0.35, 0.35]
  const bus: FanoutBusSpec = {
    busId: "BUS",
    connectionNames: ["SIGNAL"],
    sourceComponentId: "soc",
    ...busOverrides,
  }
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    obstacles: coordinates.flatMap((x, column) =>
      coordinates.map((y, row) => {
        const pointId = `soc-pad-${column}-${row}`
        return {
          obstacleId: pointId,
          componentId: "soc",
          type: "rect" as const,
          center: { x, y },
          width: 0.3,
          height: 0.3,
          layers: ["top"],
          connectedTo: [
            pointId,
            ...(column === 1 && row === 1 ? ["SIGNAL"] : []),
          ],
        }
      }),
    ),
    connections: [
      {
        name: "SIGNAL",
        pointsToConnect: [
          {
            x: 0.35,
            y: 0.35,
            layer: "top",
            pointId: "soc-pad-1-1",
          },
          { x: 2, y: 0.35, layer: "bottom" },
        ],
      },
    ],
    buses: [bus],
  }
  return { simpleRouteJson, bus }
}
