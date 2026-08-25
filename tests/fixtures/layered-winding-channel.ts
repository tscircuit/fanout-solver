import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutBusSpec } from "lib/types"

const pitch = 0.8
const padSize = 0.3
const coordinates = Array.from(
  { length: 4 },
  (_, index) => (index - 1.5) * pitch,
)

const sourcePads = coordinates.map((x, column) => ({
  connectionName: `DATA${column}`,
  obstacleId: `soc-pad-${column}-3`,
  point: { x, y: coordinates[3]! },
}))

const targetByConnection: Record<
  string,
  { x: number; y: number; layer: string }
> = {
  DATA0: { x: 8, y: 0.6, layer: "inner2" },
  DATA1: { x: 8, y: -0.6, layer: "inner1" },
  DATA2: { x: 8, y: 0.6, layer: "inner1" },
  DATA3: { x: 8, y: 0, layer: "inner2" },
}

export const windingTargetOrder = ["DATA1", "DATA3", "DATA0", "DATA2"]

export function createLayeredWindingChannelFixture(params: {
  includeTargetLayers: boolean
}): {
  simpleRouteJson: SimpleRouteJson
  bus: FanoutBusSpec
  sharedBoundary: SimpleRouteJson["bounds"]
} {
  const obstacles: Obstacle[] = coordinates.flatMap((x, column) =>
    coordinates.map((y, row) => {
      const obstacleId = `soc-pad-${column}-${row}`
      const connectionName = sourcePads.find(
        (sourcePad) => sourcePad.obstacleId === obstacleId,
      )?.connectionName
      return {
        obstacleId,
        componentId: "soc",
        type: "rect" as const,
        center: { x, y },
        width: padSize,
        height: padSize,
        layers: ["top"],
        connectedTo: [obstacleId, ...(connectionName ? [connectionName] : [])],
      }
    }),
  )
  const connectionExitTargets = Object.fromEntries(
    Object.entries(targetByConnection).map(([connectionName, target]) => [
      connectionName,
      params.includeTargetLayers ? { ...target } : { x: target.x, y: target.y },
    ]),
  )
  const bus: FanoutBusSpec = {
    busId: "DATA_BUS",
    connectionNames: sourcePads.map((sourcePad) => sourcePad.connectionName),
    sourceComponentId: "soc",
    direction: "up",
    preferredExit: "top-right",
    exitEdge: "right",
    allowedLayers: ["inner1", "inner2"],
    connectionExitTargets,
  }
  const sharedBoundary = { minX: -3, maxX: 4, minY: -3, maxY: 4 }
  return {
    bus,
    sharedBoundary,
    simpleRouteJson: {
      layerCount: 4,
      minTraceWidth: 0.1,
      nominalTraceWidth: 0.1,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minTraceToPadEdgeClearance: 0.1,
      minViaEdgeToPadEdgeClearance: 0.1,
      defaultObstacleMargin: 0.1,
      bounds: sharedBoundary,
      obstacles,
      connections: sourcePads.map((sourcePad) => {
        const target = targetByConnection[sourcePad.connectionName]
        return {
          name: sourcePad.connectionName,
          pointsToConnect: [
            {
              ...sourcePad.point,
              layer: "top",
              pointId: sourcePad.obstacleId,
            },
            { x: target.x, y: target.y, layer: target.layer },
          ],
        }
      }),
      buses: [bus],
    },
  }
}
