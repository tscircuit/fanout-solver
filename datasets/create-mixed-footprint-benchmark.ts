import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { fp } from "@tscircuit/footprinter"
import type { PcbSmtPad } from "circuit-json"
import type { Bounds } from "lib/types"

type RectPad = Extract<PcbSmtPad, { shape: "rect" }>
type CirclePad = Extract<PcbSmtPad, { shape: "circle" }>
type Rotation = 0 | 90 | 180 | 270
type BreakoutDirection = "NORTH" | "EAST" | "SOUTH" | "WEST"
type BusGrouping = "side" | "grid-line" | "individual"

export interface MixedFootprintSpec {
  componentId: string
  footprinterString: string
  center: { x: number; y: number }
  rotation: Rotation
  breakoutMode: "four-side" | "outward"
  breakoutDirection?: BreakoutDirection
  busGrouping?: BusGrouping
}

export interface MixedFootprintBenchmarkParams {
  footprints: MixedFootprintSpec[]
  layerCount?: number
  boundaryMargin?: number
  traceWidth?: number
  viaDiameter?: number
  viaHoleDiameter?: number
  clearance?: number
  targetMargin?: number
  targetLaneExtraClearance?: number
}

interface PositionedPad {
  componentId: string
  x: number
  y: number
  width: number
  height: number
  shape: "circle" | "rect"
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
      (element): element is CirclePad | RectPad =>
        element.type === "pcb_smtpad" &&
        (element.shape === "circle" || element.shape === "rect"),
    )
    .map((pad, padIndex) => {
      const rotatedCenter = rotatePoint(pad, footprint.rotation)
      const swapsDimensions =
        footprint.rotation === 90 || footprint.rotation === 270
      const width =
        pad.shape === "circle"
          ? pad.radius * 2
          : swapsDimensions
            ? pad.height
            : pad.width
      const height =
        pad.shape === "circle"
          ? pad.radius * 2
          : swapsDimensions
            ? pad.width
            : pad.height
      return {
        componentId: footprint.componentId,
        x: rotatedCenter.x + footprint.center.x,
        y: rotatedCenter.y + footprint.center.y,
        width,
        height,
        shape: pad.shape,
        padIndex,
      }
    })

  if (pads.length === 0) {
    throw new Error(
      `Mixed benchmark footprint "${footprint.footprinterString}" contains no supported SMT pads`,
    )
  }

  return {
    pads,
    bounds: {
      minX: Math.min(...pads.map((pad) => pad.x - pad.width / 2)),
      maxX: Math.max(...pads.map((pad) => pad.x + pad.width / 2)),
      minY: Math.min(...pads.map((pad) => pad.y - pad.height / 2)),
      maxY: Math.max(...pads.map((pad) => pad.y + pad.height / 2)),
    },
  }
}

function getPadSide(
  pad: PositionedPad,
  bounds: Bounds,
  tieIndex = pad.padIndex,
): BreakoutDirection {
  const distances: Array<[BreakoutDirection, number]> = [
    ["WEST", Math.abs(pad.x - pad.width / 2 - bounds.minX)],
    ["EAST", Math.abs(bounds.maxX - (pad.x + pad.width / 2))],
    ["SOUTH", Math.abs(pad.y - pad.height / 2 - bounds.minY)],
    ["NORTH", Math.abs(bounds.maxY - (pad.y + pad.height / 2))],
  ]
  const minimumDistance = Math.min(...distances.map((entry) => entry[1]))
  const nearestDirections = distances.filter(
    (entry) => Math.abs(entry[1] - minimumDistance) < 1e-6,
  )
  return nearestDirections[tieIndex % nearestDirections.length]![0]
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
  direction: BreakoutDirection,
  targetLane: number,
  sharedBoundary: Bounds,
  targetMargin: number,
): { x: number; y: number; layer: string } {
  switch (direction) {
    case "NORTH":
      return {
        x: targetLane,
        y: sharedBoundary.maxY + targetMargin,
        layer: "top",
      }
    case "EAST":
      return {
        x: sharedBoundary.maxX + targetMargin,
        y: targetLane,
        layer: "top",
      }
    case "SOUTH":
      return {
        x: targetLane,
        y: sharedBoundary.minY - targetMargin,
        layer: "top",
      }
    case "WEST":
      return {
        x: sharedBoundary.minX - targetMargin,
        y: targetLane,
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
  const targetMargin = resolvePositiveNumber(
    "Mixed benchmark targetMargin",
    params.targetMargin ?? boundaryMargin,
  )
  const targetLaneExtraClearance = params.targetLaneExtraClearance ?? 0.01
  if (
    !Number.isFinite(targetLaneExtraClearance) ||
    targetLaneExtraClearance < 0
  ) {
    throw new Error(
      "Mixed benchmark targetLaneExtraClearance must be a non-negative number",
    )
  }
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
  const directionByPad = new Map<PositionedPad, BreakoutDirection>()

  for (
    let footprintIndex = 0;
    footprintIndex < params.footprints.length;
    footprintIndex++
  ) {
    const footprint = params.footprints[footprintIndex]!
    const geometry = geometries[footprintIndex]!
    const outwardDirection =
      footprint.breakoutMode === "outward"
        ? (footprint.breakoutDirection ??
          getOutwardDirection(footprint.center, layoutCenter))
        : null
    const yCoordinates = [...new Set(geometry.pads.map((pad) => pad.y))].sort(
      (a, b) => a - b,
    )
    for (const pad of geometry.pads) {
      const tieIndex =
        footprint.busGrouping === "grid-line"
          ? pad.padIndex + yCoordinates.indexOf(pad.y)
          : pad.padIndex
      directionByPad.set(
        pad,
        outwardDirection ?? getPadSide(pad, geometry.bounds, tieIndex),
      )
    }
  }

  const targetLaneByPad = new Map<PositionedPad, number>()
  const targetLanePitch = traceWidth + clearance + targetLaneExtraClearance
  for (const direction of [
    "NORTH",
    "EAST",
    "SOUTH",
    "WEST",
  ] as const satisfies readonly BreakoutDirection[]) {
    const directionPads = geometries
      .flatMap((geometry) => geometry.pads)
      .filter((pad) => directionByPad.get(pad) === direction)
      .toSorted((a, b) => {
        const aPerpendicular =
          direction === "NORTH" || direction === "SOUTH" ? a.x : a.y
        const bPerpendicular =
          direction === "NORTH" || direction === "SOUTH" ? b.x : b.y
        return (
          aPerpendicular - bPerpendicular ||
          a.componentId.localeCompare(b.componentId) ||
          a.padIndex - b.padIndex
        )
      })
    if (directionPads.length === 0) continue
    const desiredLanes = directionPads.map((pad) =>
      direction === "NORTH" || direction === "SOUTH" ? pad.x : pad.y,
    )
    const resolvedLanes: number[] = []
    for (let index = 0; index < directionPads.length; index++) {
      resolvedLanes.push(
        index === 0
          ? desiredLanes[index]!
          : Math.max(
              desiredLanes[index]!,
              resolvedLanes[index - 1]! + targetLanePitch,
            ),
      )
    }
    const meanDesired =
      desiredLanes.reduce((sum, lane) => sum + lane, 0) / desiredLanes.length
    const meanResolved =
      resolvedLanes.reduce((sum, lane) => sum + lane, 0) / resolvedLanes.length
    for (let index = 0; index < directionPads.length; index++) {
      targetLaneByPad.set(
        directionPads[index]!,
        resolvedLanes[index]! + meanDesired - meanResolved,
      )
    }
  }

  for (
    let footprintIndex = 0;
    footprintIndex < params.footprints.length;
    footprintIndex++
  ) {
    const footprint = params.footprints[footprintIndex]!
    const geometry = geometries[footprintIndex]!
    const xCoordinates = [...new Set(geometry.pads.map((pad) => pad.x))].sort(
      (a, b) => a - b,
    )
    const yCoordinates = [...new Set(geometry.pads.map((pad) => pad.y))].sort(
      (a, b) => a - b,
    )
    const busGrouping =
      footprint.busGrouping ??
      (footprint.breakoutMode === "four-side" ? "side" : "individual")
    const padGroups = new Map<
      string,
      { direction: BreakoutDirection; pads: PositionedPad[] }
    >()
    for (const positionedPad of geometry.pads) {
      const direction = directionByPad.get(positionedPad)!
      const groupId = (() => {
        if (busGrouping === "side") return direction.toLowerCase()
        if (busGrouping === "individual") {
          return `${direction.toLowerCase()}:pad-${positionedPad.padIndex + 1}`
        }
        return direction === "NORTH" || direction === "SOUTH"
          ? `${direction.toLowerCase()}:row-${yCoordinates.indexOf(positionedPad.y) + 1}`
          : `${direction.toLowerCase()}:column-${xCoordinates.indexOf(positionedPad.x) + 1}`
      })()
      const group = padGroups.get(groupId) ?? { direction, pads: [] }
      group.pads.push(positionedPad)
      padGroups.set(groupId, group)
    }

    for (const [groupId, group] of padGroups) {
      const { direction } = group
      const busId = `${footprint.componentId}:${groupId}`
      const connectionNames: string[] = []
      for (const pad of group.pads) {
        const { padIndex } = pad
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
            getTargetPoint(
              direction,
              targetLaneByPad.get(pad)!,
              sharedBoundary,
              targetMargin,
            ),
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
          ...(pad.shape === "circle" ? { shape: "circle" as const } : {}),
        } satisfies Obstacle & { shape?: "circle" })
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
