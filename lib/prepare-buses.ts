import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { distance, pointIsInsideObstacle } from "./geometry"
import type {
  Bounds,
  FanoutBusSpec,
  FanoutDirection,
  FanoutSolverOptions,
  PreparedBus,
  PreparedConnection,
} from "./types"

interface ComponentGrid {
  componentId: string
  obstacles: Obstacle[]
  xCoordinates: number[]
  yCoordinates: number[]
  pitchX: number
  pitchY: number
  bounds: Bounds
}

function uniqueSorted(values: number[]): number[] {
  const sortedValues = [...values].sort((a, b) => a - b)
  const result: number[] = []
  for (const value of sortedValues) {
    if (
      result.length === 0 ||
      Math.abs(result[result.length - 1]! - value) > 1e-6
    ) {
      result.push(value)
    }
  }
  return result
}

function getPitch(coordinates: number[]): number {
  let pitch = Number.POSITIVE_INFINITY
  for (let index = 1; index < coordinates.length; index++) {
    const difference = coordinates[index]! - coordinates[index - 1]!
    if (difference > 1e-6) pitch = Math.min(pitch, difference)
  }
  return pitch
}

function getComponentBounds(obstacles: Obstacle[]): Bounds {
  return {
    minX: Math.min(
      ...obstacles.map((obstacle) => obstacle.center.x - obstacle.width / 2),
    ),
    maxX: Math.max(
      ...obstacles.map((obstacle) => obstacle.center.x + obstacle.width / 2),
    ),
    minY: Math.min(
      ...obstacles.map((obstacle) => obstacle.center.y - obstacle.height / 2),
    ),
    maxY: Math.max(
      ...obstacles.map((obstacle) => obstacle.center.y + obstacle.height / 2),
    ),
  }
}

function findComponentGrids(obstacles: Obstacle[]): ComponentGrid[] {
  const obstaclesByComponent = new Map<string, Obstacle[]>()
  for (const obstacle of obstacles) {
    if (!obstacle.componentId || obstacle.isCopperPour) continue
    const componentObstacles =
      obstaclesByComponent.get(obstacle.componentId) ?? []
    componentObstacles.push(obstacle)
    obstaclesByComponent.set(obstacle.componentId, componentObstacles)
  }

  const grids: ComponentGrid[] = []
  for (const [componentId, componentObstacles] of obstaclesByComponent) {
    if (componentObstacles.length < 4) continue
    const xCoordinates = uniqueSorted(
      componentObstacles.map((obstacle) => obstacle.center.x),
    )
    const yCoordinates = uniqueSorted(
      componentObstacles.map((obstacle) => obstacle.center.y),
    )
    if (xCoordinates.length < 2 || yCoordinates.length < 2) continue
    const pitchX = getPitch(xCoordinates)
    const pitchY = getPitch(yCoordinates)
    if (!Number.isFinite(pitchX) || !Number.isFinite(pitchY)) continue
    grids.push({
      componentId,
      obstacles: componentObstacles,
      xCoordinates,
      yCoordinates,
      pitchX,
      pitchY,
      bounds: getComponentBounds(componentObstacles),
    })
  }
  return grids
}

function getPointLayers(point: ConnectionPoint): string[] {
  return "layer" in point ? [point.layer] : point.layers
}

function findPointObstacleMatches(params: {
  point: ConnectionPoint
  connection: SimpleRouteConnection
  componentGrids: ComponentGrid[]
}): Array<{ grid: ComponentGrid; obstacle: Obstacle }> {
  const { point, connection, componentGrids } = params
  const pointLayers = getPointLayers(point)
  const matches: Array<{ grid: ComponentGrid; obstacle: Obstacle }> = []

  for (const grid of componentGrids) {
    const candidateObstacles = grid.obstacles
      .filter((obstacle) =>
        obstacle.layers.some((layer) => pointLayers.includes(layer)),
      )
      .filter((obstacle) => pointIsInsideObstacle(point, obstacle, 1e-5))
      .sort((a, b) => {
        const aDirect =
          a.connectedTo.includes(connection.name) ||
          a.connectedTo.includes(point.pointId ?? "") ||
          a.connectedTo.includes(point.pcb_port_id ?? "")
        const bDirect =
          b.connectedTo.includes(connection.name) ||
          b.connectedTo.includes(point.pointId ?? "") ||
          b.connectedTo.includes(point.pcb_port_id ?? "")
        if (aDirect !== bDirect) return aDirect ? -1 : 1
        return a.width * a.height - b.width * b.height
      })
    if (candidateObstacles[0]) {
      matches.push({ grid, obstacle: candidateObstacles[0] })
    }
  }

  return matches
}

function inferBusId(connection: SimpleRouteConnection): string | null {
  for (const point of connection.pointsToConnect) {
    if ("layers" in point && point.busId) return point.busId
  }
  const nameMatch = /^BUS[_:-]([^_:-]+)(?:[_:-]\d+)?$/i.exec(connection.name)
  return nameMatch?.[1] ?? null
}

function resolveBusSpecs(
  srj: SimpleRouteJson,
  options: FanoutSolverOptions,
): FanoutBusSpec[] {
  const requestedBuses = options.buses ?? srj.buses
  const specsById = new Map<string, FanoutBusSpec>()
  const claimedConnectionNames = new Set<string>()
  const knownConnectionNames = new Set(
    srj.connections.map((connection) => connection.name),
  )

  for (const requestedBus of requestedBuses ?? []) {
    if (specsById.has(requestedBus.busId)) {
      throw new Error(`FanoutSolver: duplicate bus id "${requestedBus.busId}"`)
    }
    for (const connectionName of requestedBus.connectionNames) {
      if (!knownConnectionNames.has(connectionName)) {
        throw new Error(
          `FanoutSolver: bus "${requestedBus.busId}" references unknown connection "${connectionName}"`,
        )
      }
      if (claimedConnectionNames.has(connectionName)) {
        throw new Error(
          `FanoutSolver: connection "${connectionName}" belongs to more than one bus`,
        )
      }
      claimedConnectionNames.add(connectionName)
    }
    specsById.set(requestedBus.busId, {
      ...requestedBus,
      direction:
        options.busDirections?.[requestedBus.busId] ??
        (requestedBus as FanoutBusSpec).direction,
    })
  }

  for (const connection of srj.connections) {
    if (claimedConnectionNames.has(connection.name)) continue
    const inferredBusId = inferBusId(connection)
    if (inferredBusId) {
      const existing = specsById.get(inferredBusId)
      specsById.set(inferredBusId, {
        busId: inferredBusId,
        connectionNames: [
          ...(existing?.connectionNames ?? []),
          connection.name,
        ],
        direction:
          options.busDirections?.[inferredBusId] ?? existing?.direction,
      })
    } else {
      const singletonBusId = `connection:${connection.name}`
      specsById.set(singletonBusId, {
        busId: singletonBusId,
        connectionNames: [connection.name],
        direction: options.busDirections?.[singletonBusId],
      })
    }
  }

  return [...specsById.values()]
}

function chooseSourceGrid(params: {
  busSpec: FanoutBusSpec
  connections: SimpleRouteConnection[]
  componentGrids: ComponentGrid[]
}): ComponentGrid {
  const { busSpec, connections, componentGrids } = params
  const matchCountByComponent = new Map<string, number>()

  for (const connection of connections) {
    const matchedComponents = new Set<string>()
    for (const point of connection.pointsToConnect) {
      for (const match of findPointObstacleMatches({
        point,
        connection,
        componentGrids,
      })) {
        matchedComponents.add(match.grid.componentId)
      }
    }
    for (const componentId of matchedComponents) {
      matchCountByComponent.set(
        componentId,
        (matchCountByComponent.get(componentId) ?? 0) + 1,
      )
    }
  }

  const selectedGrid = [...componentGrids].sort((a, b) => {
    const countDifference =
      (matchCountByComponent.get(b.componentId) ?? 0) -
      (matchCountByComponent.get(a.componentId) ?? 0)
    if (countDifference !== 0) return countDifference
    return b.obstacles.length - a.obstacles.length
  })[0]
  const selectedMatchCount = selectedGrid
    ? (matchCountByComponent.get(selectedGrid.componentId) ?? 0)
    : 0
  if (!selectedGrid || selectedMatchCount !== connections.length) {
    throw new Error(
      `FanoutSolver: bus "${busSpec.busId}" does not have one BGA component endpoint on every connection`,
    )
  }
  return selectedGrid
}

function chooseTargetPoint(
  sourcePoint: ConnectionPoint,
  connection: SimpleRouteConnection,
  sourcePointIndex: number,
): ConnectionPoint {
  const targetCandidates = connection.pointsToConnect.filter(
    (_, pointIndex) => pointIndex !== sourcePointIndex,
  )
  const targetPoint = targetCandidates.sort(
    (a, b) => distance(sourcePoint, b) - distance(sourcePoint, a),
  )[0]
  if (!targetPoint) {
    throw new Error(
      `FanoutSolver: connection "${connection.name}" has no target beyond its BGA pad`,
    )
  }
  return targetPoint
}

function prepareConnection(params: {
  connection: SimpleRouteConnection
  connectionIndex: number
  sourceGrid: ComponentGrid
  componentGrids: ComponentGrid[]
}): PreparedConnection {
  const { connection, connectionIndex, sourceGrid, componentGrids } = params
  for (
    let sourcePointIndex = 0;
    sourcePointIndex < connection.pointsToConnect.length;
    sourcePointIndex++
  ) {
    const sourcePoint = connection.pointsToConnect[sourcePointIndex]!
    const sourceMatch = findPointObstacleMatches({
      point: sourcePoint,
      connection,
      componentGrids,
    }).find((match) => match.grid.componentId === sourceGrid.componentId)
    if (!sourceMatch) continue
    const sourceLayer = getPointLayers(sourcePoint).find((layer) =>
      sourceMatch.obstacle.layers.includes(layer),
    )
    if (!sourceLayer) {
      throw new Error(
        `FanoutSolver: connection "${connection.name}" has no source layer shared with its BGA pad`,
      )
    }
    return {
      connection,
      connectionIndex,
      sourcePoint,
      sourcePointIndex,
      sourceLayer,
      sourceObstacle: sourceMatch.obstacle,
      targetPoint: chooseTargetPoint(sourcePoint, connection, sourcePointIndex),
    }
  }
  throw new Error(
    `FanoutSolver: connection "${connection.name}" does not touch BGA component "${sourceGrid.componentId}"`,
  )
}

function inferDirection(
  busId: string,
  connections: PreparedConnection[],
): FanoutDirection {
  let dx = 0
  let dy = 0
  for (const preparedConnection of connections) {
    dx += preparedConnection.targetPoint.x - preparedConnection.sourcePoint.x
    dy += preparedConnection.targetPoint.y - preparedConnection.sourcePoint.y
  }
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    throw new Error(
      `FanoutSolver: cannot infer an escape direction for bus "${busId}"`,
    )
  }
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left"
  return dy >= 0 ? "up" : "down"
}

export function prepareFanoutBuses(
  srj: SimpleRouteJson,
  options: FanoutSolverOptions,
): PreparedBus[] {
  const componentGrids = findComponentGrids(srj.obstacles)
  if (componentGrids.length === 0 && srj.connections.length > 0) {
    throw new Error(
      "FanoutSolver: no componentId-tagged rectangular BGA pad grid was found",
    )
  }
  const connectionIndexByName = new Map(
    srj.connections.map((connection, index) => [connection.name, index]),
  )
  const buses: PreparedBus[] = []

  for (const busSpec of resolveBusSpecs(srj, options)) {
    const connections = busSpec.connectionNames.map((connectionName) => {
      const connectionIndex = connectionIndexByName.get(connectionName)
      if (connectionIndex === undefined) {
        throw new Error(
          `FanoutSolver: connection "${connectionName}" is missing from the input`,
        )
      }
      return srj.connections[connectionIndex]!
    })
    const sourceGrid = chooseSourceGrid({
      busSpec,
      connections,
      componentGrids,
    })
    const preparedConnections = connections.map((connection) =>
      prepareConnection({
        connection,
        connectionIndex: connectionIndexByName.get(connection.name)!,
        sourceGrid,
        componentGrids,
      }),
    )
    buses.push({
      busId: busSpec.busId,
      direction:
        busSpec.direction ??
        options.busDirections?.[busSpec.busId] ??
        inferDirection(busSpec.busId, preparedConnections),
      connections: preparedConnections,
      componentId: sourceGrid.componentId,
      componentObstacles: sourceGrid.obstacles,
      componentBounds: sourceGrid.bounds,
      pitchX: sourceGrid.pitchX,
      pitchY: sourceGrid.pitchY,
    })
  }

  return buses
}
