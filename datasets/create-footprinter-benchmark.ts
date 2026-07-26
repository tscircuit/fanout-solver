import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { fp } from "@tscircuit/footprinter"
import type { PcbSmtPad } from "circuit-json"

type BenchmarkPad = Extract<PcbSmtPad, { shape: "circle" }>

export interface BenchmarkFootprintParams {
  componentId: string
  center: { x: number; y: number }
  gridSize?: number
  pitch?: number
  padDiameter?: number
}

interface BenchmarkParams {
  footprints?: BenchmarkFootprintParams[]
  gridSize?: number
  layerCount?: number
  pitch?: number
  padDiameter?: number
}

interface ResolvedBenchmarkFootprint {
  componentId: string
  center: { x: number; y: number }
  gridSize: number
  pitch: number
  padDiameter: number
}

interface SelectedPad {
  pad: BenchmarkPad
  row: number
  column: number
}

const DIRECTIONS = ["NORTH", "EAST", "SOUTH", "WEST"] as const
type BenchmarkDirection = (typeof DIRECTIONS)[number]

function resolvePositiveNumber(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
  return value
}

function resolveFootprints(
  params: BenchmarkParams,
): ResolvedBenchmarkFootprint[] {
  const defaultGridSize = params.gridSize ?? 8
  const defaultPitch = params.pitch ?? 0.8
  const defaultPadDiameter = params.padDiameter ?? 0.3
  const requestedFootprints = params.footprints ?? [
    {
      componentId: "central-bga",
      center: { x: 0, y: 0 },
    },
  ]

  if (requestedFootprints.length === 0) {
    throw new Error("Benchmark must contain at least one footprint")
  }

  const componentIds = new Set<string>()
  return requestedFootprints.map((footprint) => {
    const gridSize = footprint.gridSize ?? defaultGridSize
    const pitch = resolvePositiveNumber(
      `Benchmark ${footprint.componentId} pitch`,
      footprint.pitch ?? defaultPitch,
    )
    const padDiameter = resolvePositiveNumber(
      `Benchmark ${footprint.componentId} padDiameter`,
      footprint.padDiameter ?? defaultPadDiameter,
    )

    if (!footprint.componentId) {
      throw new Error("Benchmark footprint componentId cannot be empty")
    }
    if (componentIds.has(footprint.componentId)) {
      throw new Error(
        `Benchmark contains duplicate componentId "${footprint.componentId}"`,
      )
    }
    componentIds.add(footprint.componentId)
    if (!Number.isInteger(gridSize) || gridSize < 6) {
      throw new Error(
        `Benchmark ${footprint.componentId} gridSize must be an integer of at least 6`,
      )
    }
    if (
      !Number.isFinite(footprint.center.x) ||
      !Number.isFinite(footprint.center.y)
    ) {
      throw new Error(
        `Benchmark ${footprint.componentId} center must contain finite coordinates`,
      )
    }
    if (padDiameter >= pitch) {
      throw new Error(
        `Benchmark ${footprint.componentId} padDiameter must be smaller than its pitch`,
      )
    }

    return {
      componentId: footprint.componentId,
      center: { ...footprint.center },
      gridSize,
      pitch,
      padDiameter,
    }
  })
}

function getPads(footprint: ResolvedBenchmarkFootprint): SelectedPad[] {
  const { center, gridSize, pitch, padDiameter } = footprint
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
    pad: {
      ...pad,
      x: pad.x + center.x,
      y: pad.y + center.y,
    },
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
  footprint: ResolvedBenchmarkFootprint,
  direction: BenchmarkDirection,
  targetDistance: number,
): { x: number; y: number; layer: string } {
  switch (direction) {
    case "NORTH":
      return {
        x: pad.x,
        y: footprint.center.y + targetDistance,
        layer: "top",
      }
    case "SOUTH":
      return {
        x: pad.x,
        y: footprint.center.y - targetDistance,
        layer: "top",
      }
    case "EAST":
      return {
        x: footprint.center.x + targetDistance,
        y: pad.y,
        layer: "top",
      }
    case "WEST":
      return {
        x: footprint.center.x - targetDistance,
        y: pad.y,
        layer: "top",
      }
  }
}

export function createFootprinterBenchmarkSrj(
  params: BenchmarkParams = {},
): SimpleRouteJson {
  const layerCount = params.layerCount ?? 4
  if (!Number.isInteger(layerCount) || layerCount < 1) {
    throw new Error("Benchmark layerCount must be a positive integer")
  }

  const footprints = resolveFootprints(params)
  const connections: SimpleRouteJson["connections"] = []
  const buses: NonNullable<SimpleRouteJson["buses"]> = []
  const obstacles: SimpleRouteJson["obstacles"] = []

  for (
    let footprintIndex = 0;
    footprintIndex < footprints.length;
    footprintIndex++
  ) {
    const footprint = footprints[footprintIndex]!
    const pads = getPads(footprint)
    const connectionNameByPad = new Map<BenchmarkPad, string>()
    const targetDistance = Math.max(8, footprint.gridSize * footprint.pitch)
    const connectionPrefix = `FP${String(footprintIndex + 1).padStart(2, "0")}`

    for (const direction of DIRECTIONS) {
      const busPads = selectBusPads(pads, footprint.gridSize, direction)
      const connectionNames: string[] = []
      for (let index = 0; index < busPads.length; index++) {
        const selectedPad = busPads[index]!
        const connectionName = `BUS_${connectionPrefix}_${direction}_${String(
          index + 1,
        ).padStart(2, "0")}`
        const pointId = `${footprint.componentId}:${selectedPad.row}:${selectedPad.column}`
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
            getTargetPoint(
              selectedPad.pad,
              footprint,
              direction,
              targetDistance,
            ),
          ],
        })
      }
      buses.push({
        busId: `${footprint.componentId}:${direction.toLowerCase()}`,
        connectionNames,
      })
    }

    obstacles.push(
      ...pads.map(({ pad, row, column }) => {
        const width = pad.radius * 2
        const height = pad.radius * 2
        const connectionName = connectionNameByPad.get(pad)
        const pointId = `${footprint.componentId}:${row}:${column}`
        return {
          obstacleId: `${footprint.componentId}-pad:${row}:${column}`,
          componentId: footprint.componentId,
          type: "rect" as const,
          center: { x: pad.x, y: pad.y },
          width,
          height,
          layers: ["top"],
          connectedTo: connectionName ? [connectionName, pointId] : [pointId],
        }
      }),
    )
  }

  const xExtents = [
    ...obstacles.flatMap((obstacle) => [
      obstacle.center.x - obstacle.width / 2,
      obstacle.center.x + obstacle.width / 2,
    ]),
    ...connections.flatMap((connection) =>
      connection.pointsToConnect.map((point) => point.x),
    ),
  ]
  const yExtents = [
    ...obstacles.flatMap((obstacle) => [
      obstacle.center.y - obstacle.height / 2,
      obstacle.center.y + obstacle.height / 2,
    ]),
    ...connections.flatMap((connection) =>
      connection.pointsToConnect.map((point) => point.y),
    ),
  ]

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
      minX: Math.min(...xExtents) - 1,
      maxX: Math.max(...xExtents) + 1,
      minY: Math.min(...yExtents) - 1,
      maxY: Math.max(...yExtents) + 1,
    },
    obstacles,
    connections,
    buses,
  }
}
