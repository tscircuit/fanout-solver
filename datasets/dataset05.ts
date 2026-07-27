import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import type { Bounds, FanoutBusSpec, FanoutDirection } from "lib/types"
import rk3588AssignmentsJson from "./fixtures/rk3588-ball-assignments.json"
import type { FanoutDatasetSample } from "./dataset-types"

const PITCH = 0.8
const PAD_DIAMETER = 0.3
const VIA_DIAMETER = 0.25
const VIA_HOLE_DIAMETER = 0.15
const TRACE_WIDTH = 0.1
const CLEARANCE = 0.1
const BOUNDARY_MARGIN = 8
const TARGET_MARGIN = 4
const COMPONENT_ID = "rk3588"
const ROW_COUNT = 34
const COLUMN_COUNT = 34
const GROUND_PLANE_LAYER = "inner1"
const POWER_PLANE_LAYER = "inner2"

export const RK3588_FOOTPRINTER_STRING =
  "rk3588_fcbga1088l_grid34x34_p0.8mm_pad0.3mm_68positionsomitted"

export interface Rk3588BallAssignment {
  ball: string
  position: {
    ball: string
    row: string
    column: number
    gridX: number
    gridY: number
  }
  name: string
  primaryName: string
  alternateNames: string[]
  categoryId: string
  electrical: {
    pinType: string | null
    defaultPinType: string | null
    powerDomain: string | null
    supportedVoltage: string | null
  }
}

export interface Rk3588AssignmentFile {
  schemaVersion: number
  device: {
    manufacturer: string
    name: string
    package: string
  }
  grid: {
    rowLabels: string[]
    columnLabels: number[]
    rowCount: number
    columnCount: number
    potentialPositionCount: number
    populatedBallCount: number
    unpopulatedPositionCount: number
  }
  balls: Rk3588BallAssignment[]
  unpopulatedPositions: Array<{
    ball: string
    row: string
    column: number
    gridX: number
    gridY: number
  }>
}

export const rk3588BallAssignments =
  rk3588AssignmentsJson as Rk3588AssignmentFile

type Rk3588Connection = SimpleRouteConnection & {
  rk3588BallAssignment: Rk3588BallAssignment
}

type Rk3588Obstacle = Obstacle & {
  shape: "circle"
  rk3588BallAssignment: Rk3588BallAssignment
}

function getBallCenter(ball: Rk3588BallAssignment): {
  x: number
  y: number
} {
  return {
    x: (ball.position.gridX - (COLUMN_COUNT - 1) / 2) * PITCH,
    y: ((ROW_COUNT - 1) / 2 - ball.position.gridY) * PITCH,
  }
}

function getNearestBoundaryDirection(
  ball: Rk3588BallAssignment,
): FanoutDirection {
  const distances = {
    left: ball.position.gridX,
    right: COLUMN_COUNT - ball.position.gridX - 1,
    up: ball.position.gridY,
    down: ROW_COUNT - ball.position.gridY - 1,
  } satisfies Record<FanoutDirection, number>
  const directionOrder = [
    "up",
    "right",
    "down",
    "left",
  ] as const satisfies readonly FanoutDirection[]
  const minimumDistance = Math.min(...Object.values(distances))
  const nearestDirections = directionOrder.filter(
    (direction) => distances[direction] === minimumDistance,
  )
  return nearestDirections[
    (ball.position.gridX + ball.position.gridY) % nearestDirections.length
  ]!
}

function getViaEdgeKey(
  ball: Rk3588BallAssignment,
  direction: FanoutDirection,
): string {
  const x2 = ball.position.gridX * 2
  const y2 = ball.position.gridY * 2
  switch (direction) {
    case "left":
      return `${x2 - 1}:${y2}`
    case "right":
      return `${x2 + 1}:${y2}`
    case "up":
      return `${x2}:${y2 - 1}`
    case "down":
      return `${x2}:${y2 + 1}`
  }
}

function allocatePlaneDirections(params: {
  planeBalls: Rk3588BallAssignment[]
  signalDirections: ReadonlyMap<string, FanoutDirection>
}): ReadonlyMap<string, FanoutDirection> {
  const { planeBalls, signalDirections } = params
  const ballByName = new Map(planeBalls.map((ball) => [ball.ball, ball]))
  const reservedSignalEdges = new Set(
    rk3588BallAssignments.balls.flatMap((ball) => {
      const direction = signalDirections.get(ball.ball)
      return direction ? [getViaEdgeKey(ball, direction)] : []
    }),
  )
  const edgeOwner = new Map<string, string>()
  const directionByBall = new Map<string, FanoutDirection>()

  function tryAssign(
    ball: Rk3588BallAssignment,
    visited: Set<string>,
  ): boolean {
    if (visited.has(ball.ball)) return false
    visited.add(ball.ball)
    const directionOrder = [
      "right",
      "down",
      "left",
      "up",
    ] as const satisfies readonly FanoutDirection[]
    const offset =
      (ball.position.gridX * 3 + ball.position.gridY) % directionOrder.length
    const candidates = directionOrder
      .map(
        (_, index) => directionOrder[(index + offset) % directionOrder.length]!,
      )
      .filter(
        (direction) => !reservedSignalEdges.has(getViaEdgeKey(ball, direction)),
      )

    for (const direction of candidates) {
      const edgeKey = getViaEdgeKey(ball, direction)
      const currentOwner = edgeOwner.get(edgeKey)
      if (
        currentOwner === undefined ||
        tryAssign(ballByName.get(currentOwner)!, visited)
      ) {
        edgeOwner.set(edgeKey, ball.ball)
        directionByBall.set(ball.ball, direction)
        return true
      }
    }
    return false
  }

  for (const ball of planeBalls) {
    if (!tryAssign(ball, new Set())) {
      throw new Error(
        `RK3588 dataset could not allocate a unique local plane via for ${ball.ball}`,
      )
    }
  }
  return directionByBall
}

function getTargetPoint(
  source: { x: number; y: number },
  direction: FanoutDirection,
  boundary: Bounds,
): { x: number; y: number; layer: string } {
  switch (direction) {
    case "left":
      return { x: boundary.minX - TARGET_MARGIN, y: source.y, layer: "top" }
    case "right":
      return { x: boundary.maxX + TARGET_MARGIN, y: source.y, layer: "top" }
    case "up":
      return { x: source.x, y: boundary.maxY + TARGET_MARGIN, layer: "top" }
    case "down":
      return { x: source.x, y: boundary.minY - TARGET_MARGIN, layer: "top" }
  }
}

function createRk3588Sample(): FanoutDatasetSample {
  const expectedBallCount = ROW_COUNT * COLUMN_COUNT - 68
  if (
    rk3588BallAssignments.device.name !== "RK3588" ||
    rk3588BallAssignments.device.package !== "FCBGA1088L" ||
    rk3588BallAssignments.grid.populatedBallCount !== expectedBallCount ||
    rk3588BallAssignments.balls.length !== expectedBallCount
  ) {
    throw new Error("RK3588 assignment fixture does not match FCBGA1088L")
  }

  const packageHalfWidth = ((COLUMN_COUNT - 1) * PITCH) / 2
  const packageHalfHeight = ((ROW_COUNT - 1) * PITCH) / 2
  const componentBounds: Bounds = {
    minX: -packageHalfWidth - PAD_DIAMETER / 2,
    maxX: packageHalfWidth + PAD_DIAMETER / 2,
    minY: -packageHalfHeight - PAD_DIAMETER / 2,
    maxY: packageHalfHeight + PAD_DIAMETER / 2,
  }
  const sharedBoundary: Bounds = {
    minX: componentBounds.minX - BOUNDARY_MARGIN,
    maxX: componentBounds.maxX + BOUNDARY_MARGIN,
    minY: componentBounds.minY - BOUNDARY_MARGIN,
    maxY: componentBounds.maxY + BOUNDARY_MARGIN,
  }
  const signalBalls = rk3588BallAssignments.balls.filter(
    (ball) => ball.categoryId !== "ground" && ball.categoryId !== "power",
  )
  const planeBalls = rk3588BallAssignments.balls.filter(
    (ball) => ball.categoryId === "ground" || ball.categoryId === "power",
  )
  const signalDirections = new Map(
    signalBalls.map((ball) => [ball.ball, getNearestBoundaryDirection(ball)]),
  )
  const planeDirections = allocatePlaneDirections({
    planeBalls,
    signalDirections,
  })
  const connectionNameByBall = new Map<string, string>()
  const connections: Rk3588Connection[] = []
  const obstacles: Rk3588Obstacle[] = []
  const boundaryBusConnections = new Map<
    string,
    { direction: FanoutDirection; connectionNames: string[] }
  >()
  const buses: FanoutBusSpec[] = []

  for (const ball of rk3588BallAssignments.balls) {
    const source = getBallCenter(ball)
    const connectionName = `RK3588:${ball.ball}:${ball.name}`
    const pointId = `rk3588-ball:${ball.ball}`
    const isPlane = ball.categoryId === "ground" || ball.categoryId === "power"
    connectionNameByBall.set(ball.ball, connectionName)
    const direction = isPlane
      ? planeDirections.get(ball.ball)!
      : signalDirections.get(ball.ball)!
    connections.push({
      name: connectionName,
      pointsToConnect: [
        {
          ...source,
          layer: "top",
          pointId,
          pcb_port_id: pointId,
        },
        ...(isPlane ? [] : [getTargetPoint(source, direction, sharedBoundary)]),
      ],
      rk3588BallAssignment: ball,
    })

    if (isPlane) {
      buses.push({
        busId: `rk3588:${ball.categoryId}:${ball.ball}`,
        connectionNames: [connectionName],
        direction,
        termination: {
          type: "plane",
          layer:
            ball.categoryId === "ground"
              ? GROUND_PLANE_LAYER
              : POWER_PLANE_LAYER,
        },
      })
    } else {
      const lineNumber =
        direction === "left" || direction === "right"
          ? ball.position.gridX
          : ball.position.gridY
      const busId = `rk3588:signal:${direction}:line-${String(
        lineNumber + 1,
      ).padStart(2, "0")}`
      const bus = boundaryBusConnections.get(busId) ?? {
        direction,
        connectionNames: [],
      }
      bus.connectionNames.push(connectionName)
      boundaryBusConnections.set(busId, bus)
    }
  }

  for (const [busId, bus] of boundaryBusConnections) {
    const partCount = Math.ceil(bus.connectionNames.length / 3)
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      buses.push({
        busId:
          partCount === 1
            ? busId
            : `${busId}:part-${String(partIndex + 1).padStart(2, "0")}`,
        connectionNames: bus.connectionNames.slice(
          partIndex * 3,
          (partIndex + 1) * 3,
        ),
        direction: bus.direction,
        termination: { type: "boundary" },
      })
    }
  }

  for (const ball of rk3588BallAssignments.balls) {
    const center = getBallCenter(ball)
    const connectionName = connectionNameByBall.get(ball.ball)!
    const pointId = `rk3588-ball:${ball.ball}`
    obstacles.push({
      obstacleId: `rk3588-pad:${ball.ball}`,
      componentId: COMPONENT_ID,
      type: "rect",
      shape: "circle",
      center,
      width: PAD_DIAMETER,
      height: PAD_DIAMETER,
      layers: ["top"],
      connectedTo: [connectionName, pointId],
      rk3588BallAssignment: ball,
    })
  }

  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 6,
    minTraceWidth: TRACE_WIDTH,
    nominalTraceWidth: TRACE_WIDTH,
    minViaPadDiameter: VIA_DIAMETER,
    minViaHoleDiameter: VIA_HOLE_DIAMETER,
    minTraceToPadEdgeClearance: CLEARANCE,
    minViaEdgeToPadEdgeClearance: CLEARANCE,
    defaultObstacleMargin: CLEARANCE,
    bounds: {
      minX: sharedBoundary.minX - TARGET_MARGIN - 1,
      maxX: sharedBoundary.maxX + TARGET_MARGIN + 1,
      minY: sharedBoundary.minY - TARGET_MARGIN - 1,
      maxY: sharedBoundary.maxY + TARGET_MARGIN + 1,
    },
    obstacles,
    connections,
    buses: buses as NonNullable<SimpleRouteJson["buses"]>,
  }

  return {
    id: "sample001",
    name: "Exact RK3588 FCBGA1088L plane-aware breakout",
    description:
      "Preserves all 1,088 published RK3588 ball names and positions. The 422 ground balls terminate locally on inner1, the 167 power balls terminate locally on inner2, and the remaining 499 signal balls escape to one shared boundary on four routing layers.",
    footprintCount: 1,
    footprinterStrings: [RK3588_FOOTPRINTER_STRING],
    simpleRouteJson,
    solverOptions: {
      buses,
      componentBounds: { [COMPONENT_ID]: componentBounds },
      sharedBoundary,
      escapeLayers: ["top", "inner3", "inner4", "bottom"],
      maxLayerCombinations: 1,
    },
    componentBounds: { [COMPONENT_ID]: componentBounds },
    sharedBoundary,
  }
}

export const fanoutDataset05: FanoutDatasetSample[] = [createRk3588Sample()]
