import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { fp } from "@tscircuit/footprinter"
import type { PcbSmtPad } from "circuit-json"
import type { Bounds } from "lib/types"

type BenchmarkPad = Extract<PcbSmtPad, { shape: "circle" }>

export interface BenchmarkFootprintParams {
  componentId: string
  center: { x: number; y: number }
  gridSize?: number
  rowCount?: number
  columnCount?: number
  pitch?: number
  padDiameter?: number
}

export interface BenchmarkParams {
  footprints?: BenchmarkFootprintParams[]
  gridSize?: number
  layerCount?: number
  busDirectionMode?: "four-side" | "layout-aware" | "vertical-split"
  pitch?: number
  padDiameter?: number
  boundaryMargin?: number
  traceWidth?: number
  viaDiameter?: number
  viaHoleDiameter?: number
  clearance?: number
  maxConnectionsPerBus?: number
}

interface ResolvedBenchmarkFootprint {
  componentId: string
  center: { x: number; y: number }
  rowCount: number
  columnCount: number
  pitch: number
  padDiameter: number
  footprinterString: string
}

interface SelectedPad {
  pad: BenchmarkPad
  row: number
  column: number
}

interface FootprintGeometry {
  pads: SelectedPad[]
  footprintBounds: Bounds
}

export interface FootprinterBenchmarkProblem {
  simpleRouteJson: SimpleRouteJson
  componentBounds: Readonly<Record<string, Bounds>>
  sharedBoundary: Bounds
  footprinterStrings: string[]
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
    const rowCount = footprint.rowCount ?? footprint.gridSize ?? defaultGridSize
    const columnCount =
      footprint.columnCount ?? footprint.gridSize ?? defaultGridSize
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
    if (
      !Number.isInteger(rowCount) ||
      rowCount < 4 ||
      !Number.isInteger(columnCount) ||
      columnCount < 4
    ) {
      throw new Error(
        `Benchmark ${footprint.componentId} rowCount and columnCount must be integers of at least 4`,
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
      rowCount,
      columnCount,
      pitch,
      padDiameter,
      footprinterString: `bga${rowCount * columnCount}_grid${columnCount}x${rowCount}_p${pitch}mm_pad${padDiameter}mm_circularpads`,
    }
  })
}

function getFootprintGeometry(
  footprint: ResolvedBenchmarkFootprint,
): FootprintGeometry {
  const { center, columnCount, footprinterString } = footprint
  const circuitJson = fp.string(footprinterString).circuitJson()
  const pads = circuitJson
    .filter(
      (element): element is BenchmarkPad =>
        element.type === "pcb_smtpad" && element.shape === "circle",
    )
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))

  return {
    pads: pads.map((pad, index) => ({
      pad: {
        ...pad,
        x: pad.x + center.x,
        y: pad.y + center.y,
      },
      row: Math.floor(index / columnCount),
      column: index % columnCount,
    })),
    footprintBounds: {
      minX: Math.min(...pads.map((pad) => pad.x - pad.radius)) + center.x,
      maxX: Math.max(...pads.map((pad) => pad.x + pad.radius)) + center.x,
      minY: Math.min(...pads.map((pad) => pad.y - pad.radius)) + center.y,
      maxY: Math.max(...pads.map((pad) => pad.y + pad.radius)) + center.y,
    },
  }
}

function getTargetPoint(
  pad: BenchmarkPad,
  direction: BenchmarkDirection,
  sharedBoundary: Bounds,
  targetMargin: number,
): { x: number; y: number; layer: string } {
  switch (direction) {
    case "NORTH":
      return {
        x: pad.x,
        y: sharedBoundary.maxY + targetMargin,
        layer: "top",
      }
    case "SOUTH":
      return {
        x: pad.x,
        y: sharedBoundary.minY - targetMargin,
        layer: "top",
      }
    case "EAST":
      return {
        x: sharedBoundary.maxX + targetMargin,
        y: pad.y,
        layer: "top",
      }
    case "WEST":
      return {
        x: sharedBoundary.minX - targetMargin,
        y: pad.y,
        layer: "top",
      }
  }
}

interface BenchmarkBus {
  busId: string
  direction: BenchmarkDirection
  pads: SelectedPad[]
}

function getPrimaryDirection(
  footprint: ResolvedBenchmarkFootprint,
  layoutCenter: { x: number; y: number },
): BenchmarkDirection | null {
  const dx = footprint.center.x - layoutCenter.x
  const dy = footprint.center.y - layoutCenter.y
  if (Math.hypot(dx, dy) < 1e-6) return null
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "EAST" : "WEST"
  return dy >= 0 ? "NORTH" : "SOUTH"
}

function createBenchmarkBuses(params: {
  footprint: ResolvedBenchmarkFootprint
  footprintIndex: number
  pads: SelectedPad[]
  layoutCenter: { x: number; y: number }
  maxConnectionsPerBus: number
  busDirectionMode: "four-side" | "layout-aware" | "vertical-split"
}): BenchmarkBus[] {
  const {
    footprint,
    footprintIndex,
    pads,
    layoutCenter,
    maxConnectionsPerBus,
    busDirectionMode,
  } = params
  const connectionPrefix = `FP${String(footprintIndex + 1).padStart(2, "0")}`
  const primaryDirection =
    busDirectionMode === "layout-aware"
      ? getPrimaryDirection(footprint, layoutCenter)
      : null
  const buses: BenchmarkBus[] = []

  function addSplitBuses(params: {
    baseBusId: string
    direction: BenchmarkDirection
    selectedPads: SelectedPad[]
  }): void {
    const { baseBusId, direction, selectedPads } = params
    const partCount = Math.ceil(selectedPads.length / maxConnectionsPerBus)
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      buses.push({
        busId:
          partCount === 1
            ? baseBusId
            : `${baseBusId}:part-${String(partIndex + 1).padStart(2, "0")}`,
        direction,
        pads: selectedPads.slice(
          partIndex * maxConnectionsPerBus,
          (partIndex + 1) * maxConnectionsPerBus,
        ),
      })
    }
  }

  if (busDirectionMode === "four-side") {
    const groups = new Map<
      string,
      {
        direction: BenchmarkDirection
        pads: SelectedPad[]
      }
    >()
    const directionOrder = [
      "SOUTH",
      "NORTH",
      "WEST",
      "EAST",
    ] as const satisfies readonly BenchmarkDirection[]

    for (const selectedPad of pads) {
      const distanceByDirection: Record<BenchmarkDirection, number> = {
        SOUTH: selectedPad.row,
        NORTH: footprint.rowCount - selectedPad.row - 1,
        WEST: selectedPad.column,
        EAST: footprint.columnCount - selectedPad.column - 1,
      }
      const minimumDistance = Math.min(...Object.values(distanceByDirection))
      const nearestDirections = directionOrder.filter(
        (direction) => distanceByDirection[direction] === minimumDistance,
      )
      const direction =
        nearestDirections[
          (selectedPad.row + selectedPad.column) % nearestDirections.length
        ]!
      const axis =
        direction === "SOUTH" || direction === "NORTH"
          ? `row-${String(selectedPad.row + 1).padStart(2, "0")}`
          : `column-${String(selectedPad.column + 1).padStart(2, "0")}`
      const groupId = `${direction}:${axis}`
      const group = groups.get(groupId) ?? { direction, pads: [] }
      group.pads.push(selectedPad)
      groups.set(groupId, group)
    }

    for (const [groupId, group] of groups) {
      addSplitBuses({
        baseBusId: `${footprint.componentId}:${groupId.toLowerCase()}`,
        direction: group.direction,
        selectedPads: group.pads,
      })
    }
    return buses
  }

  if (primaryDirection === "EAST" || primaryDirection === "WEST") {
    for (let column = 0; column < footprint.columnCount; column++) {
      addSplitBuses({
        baseBusId: `${footprint.componentId}:${primaryDirection.toLowerCase()}:column-${String(column + 1).padStart(2, "0")}`,
        direction: primaryDirection,
        selectedPads: pads.filter((pad) => pad.column === column),
      })
    }
    return buses
  }

  for (let row = 0; row < footprint.rowCount; row++) {
    const direction =
      primaryDirection ?? (row < footprint.rowCount / 2 ? "SOUTH" : "NORTH")
    addSplitBuses({
      baseBusId: `${footprint.componentId}:${direction.toLowerCase()}:row-${String(row + 1).padStart(2, "0")}`,
      direction,
      selectedPads: pads.filter((pad) => pad.row === row),
    })
  }

  if (buses.some((bus) => bus.pads.length === 0)) {
    throw new Error(`${connectionPrefix} produced an empty benchmark bus`)
  }
  return buses
}

export function createFootprinterBenchmarkProblem(
  params: BenchmarkParams = {},
): FootprinterBenchmarkProblem {
  const layerCount = params.layerCount ?? 4
  if (!Number.isInteger(layerCount) || layerCount < 1) {
    throw new Error("Benchmark layerCount must be a positive integer")
  }
  const traceWidth = resolvePositiveNumber(
    "Benchmark traceWidth",
    params.traceWidth ?? 0.1,
  )
  const viaDiameter = resolvePositiveNumber(
    "Benchmark viaDiameter",
    params.viaDiameter ?? 0.2,
  )
  const viaHoleDiameter = resolvePositiveNumber(
    "Benchmark viaHoleDiameter",
    params.viaHoleDiameter ?? viaDiameter * 0.5,
  )
  const clearance = resolvePositiveNumber(
    "Benchmark clearance",
    params.clearance ?? 0.06,
  )
  if (viaHoleDiameter >= viaDiameter) {
    throw new Error(
      "Benchmark viaHoleDiameter must be smaller than viaDiameter",
    )
  }
  const maxConnectionsPerBus = params.maxConnectionsPerBus ?? Number.MAX_VALUE
  if (!Number.isInteger(maxConnectionsPerBus) || maxConnectionsPerBus < 1) {
    throw new Error("Benchmark maxConnectionsPerBus must be a positive integer")
  }

  const footprints = resolveFootprints(params)
  const geometries = footprints.map((footprint) =>
    getFootprintGeometry(footprint),
  )
  const connections: SimpleRouteJson["connections"] = []
  const buses: NonNullable<SimpleRouteJson["buses"]> = []
  const obstacles: SimpleRouteJson["obstacles"] = []
  const componentBounds = Object.fromEntries(
    footprints.map((footprint, index) => [
      footprint.componentId,
      geometries[index]!.footprintBounds,
    ]),
  )
  const boundaryMargin =
    params.boundaryMargin ??
    Math.max(...footprints.map((footprint) => footprint.pitch)) * 4
  if (!Number.isFinite(boundaryMargin) || boundaryMargin < 0) {
    throw new Error("Benchmark boundaryMargin must be a non-negative number")
  }
  const sharedBoundary: Bounds = {
    minX:
      Math.min(...Object.values(componentBounds).map((bounds) => bounds.minX)) -
      boundaryMargin,
    maxX:
      Math.max(...Object.values(componentBounds).map((bounds) => bounds.maxX)) +
      boundaryMargin,
    minY:
      Math.min(...Object.values(componentBounds).map((bounds) => bounds.minY)) -
      boundaryMargin,
    maxY:
      Math.max(...Object.values(componentBounds).map((bounds) => bounds.maxY)) +
      boundaryMargin,
  }
  const layoutCenter = {
    x:
      (Math.min(...footprints.map((footprint) => footprint.center.x)) +
        Math.max(...footprints.map((footprint) => footprint.center.x))) /
      2,
    y:
      (Math.min(...footprints.map((footprint) => footprint.center.y)) +
        Math.max(...footprints.map((footprint) => footprint.center.y))) /
      2,
  }
  const targetMargin = boundaryMargin

  for (
    let footprintIndex = 0;
    footprintIndex < footprints.length;
    footprintIndex++
  ) {
    const footprint = footprints[footprintIndex]!
    const { pads } = geometries[footprintIndex]!
    const connectionNameByPad = new Map<BenchmarkPad, string>()
    const connectionPrefix = `FP${String(footprintIndex + 1).padStart(2, "0")}`

    for (const benchmarkBus of createBenchmarkBuses({
      footprint,
      footprintIndex,
      pads,
      layoutCenter,
      maxConnectionsPerBus,
      busDirectionMode: params.busDirectionMode ?? "layout-aware",
    })) {
      const connectionNames: string[] = []
      for (const selectedPad of benchmarkBus.pads) {
        const connectionName = `BUS_${connectionPrefix}_${benchmarkBus.direction}_R${String(
          selectedPad.row + 1,
        ).padStart(2, "0")}_C${String(selectedPad.column + 1).padStart(2, "0")}`
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
              benchmarkBus.direction,
              sharedBoundary,
              targetMargin,
            ),
          ],
        })
      }
      buses.push({
        busId: benchmarkBus.busId,
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
          shape: "circle" as const,
          center: { x: pad.x, y: pad.y },
          width,
          height,
          layers: ["top"],
          connectedTo: connectionName ? [connectionName, pointId] : [pointId],
        } satisfies Obstacle & { shape: "circle" }
      }),
    )
  }

  const xExtents = [
    sharedBoundary.minX,
    sharedBoundary.maxX,
    ...Object.values(componentBounds).flatMap((bounds) => [
      bounds.minX,
      bounds.maxX,
    ]),
    ...obstacles.flatMap((obstacle) => [
      obstacle.center.x - obstacle.width / 2,
      obstacle.center.x + obstacle.width / 2,
    ]),
    ...connections.flatMap((connection) =>
      connection.pointsToConnect.map((point) => point.x),
    ),
  ]
  const yExtents = [
    sharedBoundary.minY,
    sharedBoundary.maxY,
    ...Object.values(componentBounds).flatMap((bounds) => [
      bounds.minY,
      bounds.maxY,
    ]),
    ...obstacles.flatMap((obstacle) => [
      obstacle.center.y - obstacle.height / 2,
      obstacle.center.y + obstacle.height / 2,
    ]),
    ...connections.flatMap((connection) =>
      connection.pointsToConnect.map((point) => point.y),
    ),
  ]

  return {
    componentBounds,
    sharedBoundary,
    footprinterStrings: footprints.map(
      (footprint) => footprint.footprinterString,
    ),
    simpleRouteJson: {
      layerCount,
      minTraceWidth: traceWidth,
      nominalTraceWidth: traceWidth,
      minViaPadDiameter: viaDiameter,
      minViaHoleDiameter: viaHoleDiameter,
      minTraceToPadEdgeClearance: clearance,
      minViaEdgeToPadEdgeClearance: clearance,
      defaultObstacleMargin: clearance,
      bounds: {
        minX: Math.min(...xExtents) - 1,
        maxX: Math.max(...xExtents) + 1,
        minY: Math.min(...yExtents) - 1,
        maxY: Math.max(...yExtents) + 1,
      },
      obstacles,
      connections,
      buses,
    },
  }
}

export function createFootprinterBenchmarkSrj(
  params: BenchmarkParams = {},
): SimpleRouteJson {
  return createFootprinterBenchmarkProblem(params).simpleRouteJson
}
