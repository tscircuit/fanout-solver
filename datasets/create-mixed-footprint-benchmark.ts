import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { fp } from "@tscircuit/footprinter"
import type { PcbSmtPad } from "circuit-json"
import type { Bounds } from "lib/types"

type RectPad = Extract<PcbSmtPad, { shape: "rect" }>
type Rotation = 0 | 90 | 180 | 270
type BreakoutDirection = "NORTH" | "EAST" | "SOUTH" | "WEST"

export interface MixedFootprintSpec {
  componentId: string
  footprinterString: string
  center: { x: number; y: number }
  rotation: Rotation
  breakoutMode: "four-side" | "outward"
}

export interface MixedFootprintBenchmarkParams {
  footprints: MixedFootprintSpec[]
  layerCount?: number
  boundaryMargin?: number
  traceWidth?: number
  viaDiameter?: number
  viaHoleDiameter?: number
  clearance?: number
}

interface PositionedPad {
  pad: RectPad
  padIndex: number
}

interface FootprintGeometry {
  bounds: Bounds
  pads: PositionedPad[]
}

export interface MixedFootprintBenchmarkProblem {
  simpleRouteJson: SimpleRouteJson
  componentBounds: Readonly<Record<string, Bounds>>
  sharedBoundary: Bounds
  footprinterStrings: string[]
}

function resolvePositiveNumber(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
  return value
}

function rotatePoint(
  point: { x: number; y: number },
  rotation: Rotation,
): { x: number; y: number } {
  switch (rotation) {
    case 0:
      return { ...point }
    case 90:
      return { x: -point.y, y: point.x }
    case 180:
      return { x: -point.x, y: -point.y }
    case 270:
      return { x: point.y, y: -point.x }
  }
}

function getFootprintGeometry(
  footprint: MixedFootprintSpec,
): FootprintGeometry {
  const circuitJson = fp.string(footprint.footprinterString).circuitJson()
  const pads = circuitJson
    .filter(
      (element): element is RectPad =>
        element.type === "pcb_smtpad" && element.shape === "rect",
    )
    .map((pad, padIndex) => {
      const rotatedCenter = rotatePoint(pad, footprint.rotation)
      const swapsDimensions =
        footprint.rotation === 90 || footprint.rotation === 270
      return {
        pad: {
          ...pad,
          x: rotatedCenter.x + footprint.center.x,
          y: rotatedCenter.y + footprint.center.y,
          width: swapsDimensions ? pad.height : pad.width,
          height: swapsDimensions ? pad.width : pad.height,
        },
        padIndex,
      }
    })

  if (pads.length === 0) {
    throw new Error(
      `Mixed benchmark footprint "${footprint.footprinterString}" contains no rectangular SMT pads`,
    )
  }

  return {
    pads,
    bounds: {
      minX: Math.min(...pads.map(({ pad }) => pad.x - pad.width / 2)),
      maxX: Math.max(...pads.map(({ pad }) => pad.x + pad.width / 2)),
      minY: Math.min(...pads.map(({ pad }) => pad.y - pad.height / 2)),
      maxY: Math.max(...pads.map(({ pad }) => pad.y + pad.height / 2)),
    },
  }
}

function getPadSide(pad: RectPad, bounds: Bounds): BreakoutDirection {
  const distances: Array<[BreakoutDirection, number]> = [
    ["WEST", Math.abs(pad.x - pad.width / 2 - bounds.minX)],
    ["EAST", Math.abs(bounds.maxX - (pad.x + pad.width / 2))],
    ["SOUTH", Math.abs(pad.y - pad.height / 2 - bounds.minY)],
    ["NORTH", Math.abs(bounds.maxY - (pad.y + pad.height / 2))],
  ]
  return distances.toSorted((a, b) => a[1] - b[1])[0]![0]
}

function getOutwardDirection(
  center: { x: number; y: number },
  layoutCenter: { x: number; y: number },
): BreakoutDirection {
  const dx = center.x - layoutCenter.x
  const dy = center.y - layoutCenter.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "EAST" : "WEST"
  return dy >= 0 ? "NORTH" : "SOUTH"
}

function getTargetPoint(
  pad: RectPad,
  direction: BreakoutDirection,
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
    case "EAST":
      return {
        x: sharedBoundary.maxX + targetMargin,
        y: pad.y,
        layer: "top",
      }
    case "SOUTH":
      return {
        x: pad.x,
        y: sharedBoundary.minY - targetMargin,
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

export function createMixedFootprintBenchmarkProblem(
  params: MixedFootprintBenchmarkParams,
): MixedFootprintBenchmarkProblem {
  if (params.footprints.length === 0) {
    throw new Error("Mixed benchmark must contain at least one footprint")
  }
  const componentIds = new Set<string>()
  for (const footprint of params.footprints) {
    if (!footprint.componentId || componentIds.has(footprint.componentId)) {
      throw new Error(
        `Mixed benchmark componentId "${footprint.componentId}" must be non-empty and unique`,
      )
    }
    componentIds.add(footprint.componentId)
  }

  const layerCount = params.layerCount ?? 2
  if (!Number.isInteger(layerCount) || layerCount < 1) {
    throw new Error("Mixed benchmark layerCount must be a positive integer")
  }
  const traceWidth = resolvePositiveNumber(
    "Mixed benchmark traceWidth",
    params.traceWidth ?? 0.1,
  )
  const viaDiameter = resolvePositiveNumber(
    "Mixed benchmark viaDiameter",
    params.viaDiameter ?? 0.25,
  )
  const viaHoleDiameter = resolvePositiveNumber(
    "Mixed benchmark viaHoleDiameter",
    params.viaHoleDiameter ?? 0.15,
  )
  const clearance = resolvePositiveNumber(
    "Mixed benchmark clearance",
    params.clearance ?? 0.1,
  )
  const boundaryMargin = resolvePositiveNumber(
    "Mixed benchmark boundaryMargin",
    params.boundaryMargin ?? 2,
  )
  if (viaHoleDiameter >= viaDiameter) {
    throw new Error(
      "Mixed benchmark viaHoleDiameter must be smaller than viaDiameter",
    )
  }

  const geometries = params.footprints.map(getFootprintGeometry)
  const componentBounds = Object.fromEntries(
    params.footprints.map((footprint, index) => [
      footprint.componentId,
      geometries[index]!.bounds,
    ]),
  )
  const sharedBoundary: Bounds = {
    minX:
      Math.min(...geometries.map((geometry) => geometry.bounds.minX)) -
      boundaryMargin,
    maxX:
      Math.max(...geometries.map((geometry) => geometry.bounds.maxX)) +
      boundaryMargin,
    minY:
      Math.min(...geometries.map((geometry) => geometry.bounds.minY)) -
      boundaryMargin,
    maxY:
      Math.max(...geometries.map((geometry) => geometry.bounds.maxY)) +
      boundaryMargin,
  }
  const centralFootprints = params.footprints.filter(
    (footprint) => footprint.breakoutMode === "four-side",
  )
  const layoutCenterCandidates =
    centralFootprints.length > 0 ? centralFootprints : params.footprints
  const layoutCenter = {
    x:
      layoutCenterCandidates.reduce(
        (sum, footprint) => sum + footprint.center.x,
        0,
      ) / layoutCenterCandidates.length,
    y:
      layoutCenterCandidates.reduce(
        (sum, footprint) => sum + footprint.center.y,
        0,
      ) / layoutCenterCandidates.length,
  }
  const connections: SimpleRouteJson["connections"] = []
  const buses: NonNullable<SimpleRouteJson["buses"]> = []
  const obstacles: SimpleRouteJson["obstacles"] = []

  for (
    let footprintIndex = 0;
    footprintIndex < params.footprints.length;
    footprintIndex++
  ) {
    const footprint = params.footprints[footprintIndex]!
    const geometry = geometries[footprintIndex]!
    const outwardDirection =
      footprint.breakoutMode === "outward"
        ? getOutwardDirection(footprint.center, layoutCenter)
        : null
    const padGroups = new Map<
      string,
      { direction: BreakoutDirection; pads: PositionedPad[] }
    >()
    for (const positionedPad of geometry.pads) {
      const direction =
        outwardDirection ?? getPadSide(positionedPad.pad, geometry.bounds)
      const groupId =
        footprint.breakoutMode === "four-side"
          ? direction.toLowerCase()
          : `${direction.toLowerCase()}:pad-${positionedPad.padIndex + 1}`
      const group = padGroups.get(groupId) ?? { direction, pads: [] }
      group.pads.push(positionedPad)
      padGroups.set(groupId, group)
    }

    for (const [groupId, group] of padGroups) {
      const { direction } = group
      const busId = `${footprint.componentId}:${groupId}`
      const connectionNames: string[] = []
      for (const { pad, padIndex } of group.pads) {
        const pinNumber = padIndex + 1
        const connectionName = `BUS_MIX_FP${String(footprintIndex + 1).padStart(
          2,
          "0",
        )}_${direction}_P${String(pinNumber).padStart(2, "0")}`
        const pointId = `${footprint.componentId}:pad-${pinNumber}`
        connectionNames.push(connectionName)
        connections.push({
          name: connectionName,
          pointsToConnect: [
            {
              x: pad.x,
              y: pad.y,
              layer: "top",
              pointId,
              pcb_port_id: pointId,
            },
            getTargetPoint(pad, direction, sharedBoundary, boundaryMargin),
          ],
        })
        obstacles.push({
          obstacleId: `${footprint.componentId}:pad-${pinNumber}`,
          componentId: footprint.componentId,
          type: "rect",
          center: { x: pad.x, y: pad.y },
          width: pad.width,
          height: pad.height,
          layers: ["top"],
          connectedTo: [connectionName, pointId],
        } satisfies Obstacle)
      }
      buses.push({ busId, connectionNames })
    }
  }

  const xExtents = [
    sharedBoundary.minX,
    sharedBoundary.maxX,
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
    footprinterStrings: params.footprints.map(
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
