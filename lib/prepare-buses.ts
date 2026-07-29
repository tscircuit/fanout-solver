import type {
  ConnectionPoint,
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { distance, pointIsInsideObstacle } from "./geometry"
import type {
  Bounds,
  FanoutAvailableCornerAndSideInput,
  FanoutBorderTarget,
  FanoutBusSpec,
  FanoutBusTermination,
  FanoutDirection,
  FanoutSolverOptions,
  PreparedBus,
  PreparedConnection,
} from "./types"

export interface AvailableBoundaryRegion {
  direction: FanoutDirection
  preferredExit: FanoutBorderTarget
}

const FANOUT_BORDER_TARGETS = new Set<FanoutBorderTarget>([
  "left",
  "right",
  "top",
  "bottom",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
])

const AVAILABLE_BOUNDARY_REGIONS: Readonly<
  Record<FanoutAvailableCornerAndSideInput, AvailableBoundaryRegion>
> = {
  top_left: {
    direction: "up",
    preferredExit: "top-left",
  },
  top_middle: {
    direction: "up",
    preferredExit: "top",
  },
  top_right: {
    direction: "up",
    preferredExit: "top-right",
  },
  right_top: {
    direction: "right",
    preferredExit: "top-right",
  },
  right_middle: {
    direction: "right",
    preferredExit: "right",
  },
  right_bottom: {
    direction: "right",
    preferredExit: "bottom-right",
  },
  bottom_right: {
    direction: "down",
    preferredExit: "bottom-right",
  },
  bottom_middle: {
    direction: "down",
    preferredExit: "bottom",
  },
  bottom_left: {
    direction: "down",
    preferredExit: "bottom-left",
  },
  left_bottom: {
    direction: "left",
    preferredExit: "bottom-left",
  },
  left_middle: {
    direction: "left",
    preferredExit: "left",
  },
  left_top: {
    direction: "left",
    preferredExit: "top-left",
  },
  top: {
    direction: "up",
    preferredExit: "top",
  },
  right: {
    direction: "right",
    preferredExit: "right",
  },
  bottom: {
    direction: "down",
    preferredExit: "bottom",
  },
  left: {
    direction: "left",
    preferredExit: "left",
  },
}

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

function getAlignedPitch(obstacles: Obstacle[], axis: "x" | "y"): number {
  const perpendicularAxis = axis === "x" ? "y" : "x"
  let pitch = Number.POSITIVE_INFINITY
  for (let firstIndex = 0; firstIndex < obstacles.length; firstIndex++) {
    const first = obstacles[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < obstacles.length;
      secondIndex++
    ) {
      const second = obstacles[secondIndex]!
      if (
        Math.abs(
          first.center[perpendicularAxis] - second.center[perpendicularAxis],
        ) > 1e-6
      ) {
        continue
      }
      const separation = Math.abs(first.center[axis] - second.center[axis])
      if (separation > 1e-6) pitch = Math.min(pitch, separation)
    }
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

function resolveComponentBounds(
  grid: ComponentGrid,
  options: FanoutSolverOptions,
): Bounds {
  const requestedBounds = options.componentBounds?.[grid.componentId]
  if (!requestedBounds) {
    const inferredMarginX = grid.pitchX * 2.25
    const inferredMarginY = grid.pitchY * 2.25
    return {
      minX: grid.bounds.minX - inferredMarginX,
      maxX: grid.bounds.maxX + inferredMarginX,
      minY: grid.bounds.minY - inferredMarginY,
      maxY: grid.bounds.maxY + inferredMarginY,
    }
  }

  const values = [
    requestedBounds.minX,
    requestedBounds.maxX,
    requestedBounds.minY,
    requestedBounds.maxY,
  ]
  if (
    values.some((value) => !Number.isFinite(value)) ||
    requestedBounds.minX >= requestedBounds.maxX ||
    requestedBounds.minY >= requestedBounds.maxY
  ) {
    throw new Error(
      `FanoutSolver: componentBounds for "${grid.componentId}" must contain finite, increasing bounds`,
    )
  }
  if (
    requestedBounds.minX > grid.bounds.minX + 1e-6 ||
    requestedBounds.maxX < grid.bounds.maxX - 1e-6 ||
    requestedBounds.minY > grid.bounds.minY + 1e-6 ||
    requestedBounds.maxY < grid.bounds.maxY - 1e-6
  ) {
    throw new Error(
      `FanoutSolver: componentBounds for "${grid.componentId}" must contain every component pad`,
    )
  }

  return { ...requestedBounds }
}

function validateSharedBoundary(
  boundary: Bounds,
  componentGrids: ComponentGrid[],
): Bounds {
  const values = [boundary.minX, boundary.maxX, boundary.minY, boundary.maxY]
  if (
    values.some((value) => !Number.isFinite(value)) ||
    boundary.minX >= boundary.maxX ||
    boundary.minY >= boundary.maxY
  ) {
    throw new Error(
      "FanoutSolver: sharedBoundary must contain finite, increasing bounds",
    )
  }
  for (const grid of componentGrids) {
    if (
      boundary.minX > grid.bounds.minX + 1e-6 ||
      boundary.maxX < grid.bounds.maxX - 1e-6 ||
      boundary.minY > grid.bounds.minY + 1e-6 ||
      boundary.maxY < grid.bounds.maxY - 1e-6
    ) {
      throw new Error(
        `FanoutSolver: sharedBoundary must contain every pad of component "${grid.componentId}"`,
      )
    }
  }
  return { ...boundary }
}

function resolveSharedBoundary(
  componentGrids: ComponentGrid[],
  options: FanoutSolverOptions,
): Bounds {
  if (options.sharedBoundary) {
    return validateSharedBoundary(options.sharedBoundary, componentGrids)
  }

  const componentBounds = componentGrids.map((grid) =>
    resolveComponentBounds(grid, options),
  )
  const maximumPitch = Math.max(
    ...componentGrids.flatMap((grid) => [grid.pitchX, grid.pitchY]),
  )
  const inferredMargin = maximumPitch * 2.25
  return validateSharedBoundary(
    {
      minX:
        Math.min(...componentBounds.map((bounds) => bounds.minX)) -
        inferredMargin,
      maxX:
        Math.max(...componentBounds.map((bounds) => bounds.maxX)) +
        inferredMargin,
      minY:
        Math.min(...componentBounds.map((bounds) => bounds.minY)) -
        inferredMargin,
      maxY:
        Math.max(...componentBounds.map((bounds) => bounds.maxY)) +
        inferredMargin,
    },
    componentGrids,
  )
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
    const xCoordinates = uniqueSorted(
      componentObstacles.map((obstacle) => obstacle.center.x),
    )
    const yCoordinates = uniqueSorted(
      componentObstacles.map((obstacle) => obstacle.center.y),
    )
    const alignedPitchX = getAlignedPitch(componentObstacles, "x")
    const alignedPitchY = getAlignedPitch(componentObstacles, "y")
    const coordinatePitchX = getPitch(xCoordinates)
    const coordinatePitchY = getPitch(yCoordinates)
    const fallbackPitch = Math.min(
      ...[
        alignedPitchX,
        alignedPitchY,
        coordinatePitchX,
        coordinatePitchY,
      ].filter(Number.isFinite),
    )
    const padSizeFallback = Math.max(
      ...componentObstacles.flatMap((obstacle) => [
        obstacle.width,
        obstacle.height,
      ]),
    )
    const resolvedFallback = Number.isFinite(fallbackPitch)
      ? fallbackPitch
      : padSizeFallback
    const pitchX = Number.isFinite(alignedPitchX)
      ? alignedPitchX
      : Number.isFinite(coordinatePitchX)
        ? coordinatePitchX
        : resolvedFallback
    const pitchY = Number.isFinite(alignedPitchY)
      ? alignedPitchY
      : Number.isFinite(coordinatePitchY)
        ? coordinatePitchY
        : resolvedFallback
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

function resolvePreferredExit(
  busId: string,
  value: FanoutBorderTarget | undefined,
): FanoutBorderTarget | undefined {
  if (value === undefined) return undefined
  if (!FANOUT_BORDER_TARGETS.has(value)) {
    throw new Error(
      `FanoutSolver: bus "${busId}" has invalid preferredExit "${value}"`,
    )
  }
  return value
}

export function resolveAvailableBoundaryRegions(
  value: readonly FanoutAvailableCornerAndSideInput[] | undefined,
): AvailableBoundaryRegion[] | undefined {
  if (value === undefined) return undefined
  if (value.length === 0) {
    throw new Error(
      "FanoutSolver: availableCornersAndSides must contain at least one boundary region",
    )
  }

  const regions: AvailableBoundaryRegion[] = []
  const seen = new Set<string>()
  for (const input of value) {
    const region = AVAILABLE_BOUNDARY_REGIONS[input]
    if (!region) {
      throw new Error(
        `FanoutSolver: invalid availableCornersAndSides value "${input}"`,
      )
    }
    const key = `${region.direction}:${region.preferredExit}`
    if (seen.has(key)) continue
    seen.add(key)
    regions.push(region)
  }
  return regions
}

function resolveTermination(
  busId: string,
  value: FanoutBusTermination | undefined,
): FanoutBusTermination {
  if (value === undefined || value.type === "boundary") {
    return { type: "boundary" }
  }
  if (
    value.type !== "plane" ||
    typeof value.layer !== "string" ||
    value.layer.length === 0
  ) {
    throw new Error(
      `FanoutSolver: bus "${busId}" has an invalid termination target`,
    )
  }
  return { type: "plane", layer: value.layer }
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
    const termination = resolveTermination(
      requestedBus.busId,
      (requestedBus as FanoutBusSpec).termination,
    )
    const preferredExit = resolvePreferredExit(
      requestedBus.busId,
      options.busExitPreferences?.[requestedBus.busId] ??
        (requestedBus as FanoutBusSpec).preferredExit ??
        options.defaultPreferredExit,
    )
    if (termination.type === "plane" && preferredExit !== undefined) {
      throw new Error(
        `FanoutSolver: plane-terminated bus "${requestedBus.busId}" cannot also specify preferredExit`,
      )
    }
    specsById.set(requestedBus.busId, {
      ...requestedBus,
      sourceComponentId:
        (requestedBus as FanoutBusSpec).sourceComponentId ??
        options.sourceComponentId,
      direction:
        options.busDirections?.[requestedBus.busId] ??
        (requestedBus as FanoutBusSpec).direction ??
        options.defaultDirection,
      preferredExit,
      termination,
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
          options.busDirections?.[inferredBusId] ??
          existing?.direction ??
          options.defaultDirection,
        sourceComponentId:
          existing?.sourceComponentId ?? options.sourceComponentId,
        preferredExit: resolvePreferredExit(
          inferredBusId,
          options.busExitPreferences?.[inferredBusId] ??
            existing?.preferredExit ??
            options.defaultPreferredExit,
        ),
        termination: existing?.termination ?? { type: "boundary" },
      })
    } else {
      const singletonBusId = `connection:${connection.name}`
      specsById.set(singletonBusId, {
        busId: singletonBusId,
        connectionNames: [connection.name],
        sourceComponentId: options.sourceComponentId,
        direction:
          options.busDirections?.[singletonBusId] ?? options.defaultDirection,
        preferredExit: resolvePreferredExit(
          singletonBusId,
          options.busExitPreferences?.[singletonBusId] ??
            options.defaultPreferredExit,
        ),
        termination: { type: "boundary" },
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
  const requestedGrid = busSpec.sourceComponentId
    ? componentGrids.find(
        (grid) => grid.componentId === busSpec.sourceComponentId,
      )
    : undefined
  if (busSpec.sourceComponentId && !requestedGrid) {
    throw new Error(
      `FanoutSolver: source component "${busSpec.sourceComponentId}" for bus "${busSpec.busId}" was not found`,
    )
  }
  const sourceGrid = requestedGrid ?? selectedGrid
  const sourceMatchCount = sourceGrid
    ? (matchCountByComponent.get(sourceGrid.componentId) ?? 0)
    : 0
  if (!sourceGrid || sourceMatchCount !== connections.length) {
    throw new Error(
      busSpec.sourceComponentId
        ? `FanoutSolver: source component "${busSpec.sourceComponentId}" is not an endpoint on every connection in bus "${busSpec.busId}"`
        : `FanoutSolver: bus "${busSpec.busId}" does not have one component endpoint on every connection`,
    )
  }
  return sourceGrid
}

function chooseTargetPoint(
  sourcePoint: ConnectionPoint,
  connection: SimpleRouteConnection,
  sourcePointIndex: number,
  termination: FanoutBusTermination,
): ConnectionPoint {
  const targetCandidates = connection.pointsToConnect.filter(
    (_, pointIndex) => pointIndex !== sourcePointIndex,
  )
  const targetPoint = targetCandidates.sort(
    (a, b) => distance(sourcePoint, b) - distance(sourcePoint, a),
  )[0]
  if (!targetPoint && termination.type === "plane") {
    return sourcePoint
  }
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
  termination: FanoutBusTermination
}): PreparedConnection {
  const {
    connection,
    connectionIndex,
    sourceGrid,
    componentGrids,
    termination,
  } = params
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
      targetPoint: chooseTargetPoint(
        sourcePoint,
        connection,
        sourcePointIndex,
        termination,
      ),
    }
  }
  throw new Error(
    `FanoutSolver: connection "${connection.name}" does not touch component "${sourceGrid.componentId}"`,
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

function getDirectionsForBorderTarget(
  target: FanoutBorderTarget,
): FanoutDirection[] {
  switch (target) {
    case "left":
      return ["left"]
    case "right":
      return ["right"]
    case "top":
      return ["up"]
    case "bottom":
      return ["down"]
    case "top-left":
      return ["up", "left"]
    case "top-right":
      return ["up", "right"]
    case "bottom-left":
      return ["down", "left"]
    case "bottom-right":
      return ["down", "right"]
  }
}

function getAverageSourcePoint(connections: PreparedConnection[]): {
  x: number
  y: number
} {
  return {
    x:
      connections.reduce(
        (sum, connection) => sum + connection.sourcePoint.x,
        0,
      ) / connections.length,
    y:
      connections.reduce(
        (sum, connection) => sum + connection.sourcePoint.y,
        0,
      ) / connections.length,
  }
}

function getDistanceToBoundary(
  source: { x: number; y: number },
  direction: FanoutDirection,
  boundary: Bounds,
): number {
  switch (direction) {
    case "left":
      return source.x - boundary.minX
    case "right":
      return boundary.maxX - source.x
    case "up":
      return boundary.maxY - source.y
    case "down":
      return source.y - boundary.minY
  }
}

export function getRegionAnchor(
  region: AvailableBoundaryRegion,
  boundary: Bounds,
): number {
  if (region.direction === "up" || region.direction === "down") {
    if (region.preferredExit.endsWith("left")) return boundary.minX
    if (region.preferredExit.endsWith("right")) return boundary.maxX
    return (boundary.minX + boundary.maxX) / 2
  }
  if (region.preferredExit.startsWith("top")) return boundary.maxY
  if (region.preferredExit.startsWith("bottom")) return boundary.minY
  return (boundary.minY + boundary.maxY) / 2
}

function getRegionSourceCoordinate(
  source: { x: number; y: number },
  direction: FanoutDirection,
): number {
  return direction === "up" || direction === "down" ? source.x : source.y
}

function tryInferDirection(
  busId: string,
  connections: PreparedConnection[],
): FanoutDirection | undefined {
  try {
    return inferDirection(busId, connections)
  } catch {
    return undefined
  }
}

function resolveAvailableBusExit(params: {
  busId: string
  explicitDirection?: FanoutDirection
  preferredExit?: FanoutBorderTarget
  connections: PreparedConnection[]
  sharedBoundary: Bounds
  availableRegions: AvailableBoundaryRegion[]
}): { direction: FanoutDirection; preferredExit: FanoutBorderTarget } {
  const {
    busId,
    explicitDirection,
    preferredExit,
    connections,
    sharedBoundary,
    availableRegions,
  } = params
  const compatibleRegions = availableRegions.filter(
    (region) =>
      (explicitDirection === undefined ||
        region.direction === explicitDirection) &&
      (preferredExit === undefined || region.preferredExit === preferredExit),
  )
  if (compatibleRegions.length === 0) {
    throw new Error(
      `FanoutSolver: bus "${busId}" cannot use its requested exit with availableCornersAndSides`,
    )
  }

  const inferredDirection = explicitDirection
    ? undefined
    : tryInferDirection(busId, connections)
  const preferredDirectionRegions = inferredDirection
    ? compatibleRegions.filter(
        (region) => region.direction === inferredDirection,
      )
    : []
  const candidates =
    preferredDirectionRegions.length > 0
      ? preferredDirectionRegions
      : compatibleRegions
  const averageSource = getAverageSourcePoint(connections)
  return [...candidates].toSorted(
    (first, second) =>
      getDistanceToBoundary(averageSource, first.direction, sharedBoundary) -
        getDistanceToBoundary(
          averageSource,
          second.direction,
          sharedBoundary,
        ) ||
      Math.abs(
        getRegionSourceCoordinate(averageSource, first.direction) -
          getRegionAnchor(first, sharedBoundary),
      ) -
        Math.abs(
          getRegionSourceCoordinate(averageSource, second.direction) -
            getRegionAnchor(second, sharedBoundary),
        ) ||
      first.preferredExit.localeCompare(second.preferredExit),
  )[0]!
}

function resolveBusDirection(params: {
  busId: string
  explicitDirection?: FanoutDirection
  preferredExit?: FanoutBorderTarget
  connections: PreparedConnection[]
  sharedBoundary: Bounds
  availableRegions?: AvailableBoundaryRegion[]
}): { direction: FanoutDirection; preferredExit?: FanoutBorderTarget } {
  const {
    busId,
    explicitDirection,
    preferredExit,
    connections,
    sharedBoundary,
    availableRegions,
  } = params
  if (availableRegions) {
    return resolveAvailableBusExit({
      busId,
      explicitDirection,
      preferredExit,
      connections,
      sharedBoundary,
      availableRegions,
    })
  }
  if (!preferredExit) {
    return {
      direction: explicitDirection ?? inferDirection(busId, connections),
    }
  }

  const compatibleDirections = getDirectionsForBorderTarget(preferredExit)
  if (explicitDirection) {
    if (!compatibleDirections.includes(explicitDirection)) {
      throw new Error(
        `FanoutSolver: bus "${busId}" direction "${explicitDirection}" is incompatible with preferredExit "${preferredExit}"`,
      )
    }
    return { direction: explicitDirection, preferredExit }
  }
  if (compatibleDirections.length === 1) {
    return { direction: compatibleDirections[0]!, preferredExit }
  }

  let inferredDirection: FanoutDirection | undefined
  try {
    inferredDirection = inferDirection(busId, connections)
  } catch {
    inferredDirection = undefined
  }
  if (inferredDirection && compatibleDirections.includes(inferredDirection)) {
    return { direction: inferredDirection, preferredExit }
  }
  const averageSource = getAverageSourcePoint(connections)
  return {
    direction: compatibleDirections.toSorted(
      (first, second) =>
        getDistanceToBoundary(averageSource, first, sharedBoundary) -
          getDistanceToBoundary(averageSource, second, sharedBoundary) ||
        first.localeCompare(second),
    )[0]!,
    preferredExit,
  }
}

export function prepareFanoutBuses(
  srj: SimpleRouteJson,
  options: FanoutSolverOptions,
): PreparedBus[] {
  const componentGrids = findComponentGrids(srj.obstacles)
  if (componentGrids.length === 0 && srj.connections.length > 0) {
    throw new Error(
      "FanoutSolver: no componentId-tagged pad footprint was found",
    )
  }
  const connectionIndexByName = new Map(
    srj.connections.map((connection, index) => [connection.name, index]),
  )
  const resolvedBusInputs = resolveBusSpecs(srj, options).map((busSpec) => {
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
        termination: busSpec.termination ?? { type: "boundary" },
      }),
    )
    return { busSpec, sourceGrid, preparedConnections }
  })
  const sourceGrids = [
    ...new Map(
      resolvedBusInputs.map(({ sourceGrid }) => [
        sourceGrid.componentId,
        sourceGrid,
      ]),
    ).values(),
  ]
  const sharedBoundary = resolveSharedBoundary(sourceGrids, options)
  const availableRegions = resolveAvailableBoundaryRegions(
    options.availableCornersAndSides,
  )
  const buses: PreparedBus[] = []

  for (const {
    busSpec,
    sourceGrid,
    preparedConnections,
  } of resolvedBusInputs) {
    const resolvedExit = resolveBusDirection({
      busId: busSpec.busId,
      explicitDirection:
        busSpec.direction ?? options.busDirections?.[busSpec.busId],
      preferredExit: busSpec.preferredExit,
      connections: preparedConnections,
      sharedBoundary,
      availableRegions:
        busSpec.termination?.type === "plane" ? undefined : availableRegions,
    })
    buses.push({
      busId: busSpec.busId,
      direction: resolvedExit.direction,
      preferredExit: resolvedExit.preferredExit,
      termination: busSpec.termination ?? { type: "boundary" },
      connections: preparedConnections,
      componentId: sourceGrid.componentId,
      componentObstacles: sourceGrid.obstacles,
      componentBounds: resolveComponentBounds(sourceGrid, options),
      sharedBoundary,
      xCoordinates: [...sourceGrid.xCoordinates],
      yCoordinates: [...sourceGrid.yCoordinates],
      pitchX: sourceGrid.pitchX,
      pitchY: sourceGrid.pitchY,
    })
  }

  return buses
}
