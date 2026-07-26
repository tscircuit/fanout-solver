import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { fp } from "@tscircuit/footprinter"
import type { PcbSmtPad } from "circuit-json"

type BenchmarkPad = Extract<PcbSmtPad, { shape: "circle" }>

interface BenchmarkParams {
  gridSize?: number
  layerCount?: number
  pitch?: number
  padDiameter?: number
}

interface SelectedPad {
  pad: BenchmarkPad
  row: number
  column: number
}

const DIRECTIONS = ["NORTH", "EAST", "SOUTH", "WEST"] as const
type BenchmarkDirection = (typeof DIRECTIONS)[number]

function getPads(params: {
  gridSize: number
  pitch: number
  padDiameter: number
}): SelectedPad[] {
  const { gridSize, pitch, padDiameter } = params
  const circuitJson = fp()
    .bga(gridSize * gridSize)
    .grid(`${gridSize}x${gridSize}`)
    .p(pitch)
    .pad(padDiameter)
    .circularpads(true)
    .soup()
  const pads = circuitJson
    .filter(
      (element): element is BenchmarkPad =>
        element.type === "pcb_smtpad" && element.shape === "circle",
    )
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))

  return pads.map((pad, index) => ({
    pad,
    row: Math.floor(index / gridSize),
    column: index % gridSize,
  }))
}

function selectBusPads(
  pads: SelectedPad[],
  gridSize: number,
  direction: BenchmarkDirection,
): SelectedPad[] {
  switch (direction) {
    case "NORTH":
      return pads.filter(
        ({ row, column }) =>
          row === gridSize - 2 && column >= 1 && column <= gridSize - 2,
      )
    case "SOUTH":
      return pads.filter(
        ({ row, column }) => row === 1 && column >= 1 && column <= gridSize - 2,
      )
    case "EAST":
      return pads.filter(
        ({ row, column }) =>
          column === gridSize - 2 && row >= 2 && row <= gridSize - 3,
      )
    case "WEST":
      return pads.filter(
        ({ row, column }) => column === 1 && row >= 2 && row <= gridSize - 3,
      )
  }
}

function getTargetPoint(
  pad: BenchmarkPad,
  direction: BenchmarkDirection,
  targetDistance: number,
): { x: number; y: number; layer: string } {
  switch (direction) {
    case "NORTH":
      return { x: pad.x, y: targetDistance, layer: "top" }
    case "SOUTH":
      return { x: pad.x, y: -targetDistance, layer: "top" }
    case "EAST":
      return { x: targetDistance, y: pad.y, layer: "top" }
    case "WEST":
      return { x: -targetDistance, y: pad.y, layer: "top" }
  }
}

export function createFootprinterBenchmarkSrj(
  params: BenchmarkParams = {},
): SimpleRouteJson {
  const gridSize = params.gridSize ?? 8
  const layerCount = params.layerCount ?? 4
  const pitch = params.pitch ?? 0.8
  const padDiameter = params.padDiameter ?? 0.3
  if (!Number.isInteger(gridSize) || gridSize < 6) {
    throw new Error("Benchmark BGA gridSize must be an integer of at least 6")
  }
  const pads = getPads({ gridSize, pitch, padDiameter })
  const connectionNameByPad = new Map<BenchmarkPad, string>()
  const connections: SimpleRouteJson["connections"] = []
  const buses: NonNullable<SimpleRouteJson["buses"]> = []
  const targetDistance = Math.max(8, gridSize * pitch)

  for (const direction of DIRECTIONS) {
    const busPads = selectBusPads(pads, gridSize, direction)
    const connectionNames: string[] = []
    for (let index = 0; index < busPads.length; index++) {
      const selectedPad = busPads[index]!
      const connectionName = `BUS_${direction}_${String(index + 1).padStart(2, "0")}`
      const pointId = `central-bga:${selectedPad.row}:${selectedPad.column}`
      connectionNameByPad.set(selectedPad.pad, connectionName)
      connectionNames.push(connectionName)
      connections.push({
        name: connectionName,
        pointsToConnect: [
          {
            x: selectedPad.pad.x,
            y: selectedPad.pad.y,
            layer: "top",
            pointId,
            pcb_port_id: pointId,
          },
          getTargetPoint(selectedPad.pad, direction, targetDistance),
        ],
      })
    }
    buses.push({
      busId: direction.toLowerCase(),
      connectionNames,
    })
  }

  return {
    layerCount,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.2,
    minViaHoleDiameter: 0.1,
    minTraceToPadEdgeClearance: 0.06,
    minViaEdgeToPadEdgeClearance: 0.06,
    defaultObstacleMargin: 0.06,
    bounds: {
      minX: -targetDistance - 1,
      maxX: targetDistance + 1,
      minY: -targetDistance - 1,
      maxY: targetDistance + 1,
    },
    obstacles: pads.map(({ pad, row, column }) => {
      const width = pad.radius * 2
      const height = pad.radius * 2
      const connectionName = connectionNameByPad.get(pad)
      const pointId = `central-bga:${row}:${column}`
      return {
        obstacleId: `central-bga-pad:${row}:${column}`,
        componentId: "central-bga",
        type: "rect" as const,
        center: { x: pad.x, y: pad.y },
        width,
        height,
        layers: ["top"],
        connectedTo: connectionName ? [connectionName, pointId] : [pointId],
      }
    }),
    connections,
    buses,
  }
}
