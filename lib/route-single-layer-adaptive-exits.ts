import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "./geometry"
import { type AvailableBoundaryRegion, getRegionAnchor } from "./prepare-buses"
import type {
  FanoutDirection,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
} from "./types"

interface FlowRoutingParams {
  srj: SimpleRouteJson
  buses: PreparedBus[]
  traceWidth: number
  clearance: number
  availableBoundaryRegions?: AvailableBoundaryRegion[]
}

interface FlowItem {
  bus: PreparedBus
  connection: PreparedConnection
  source: Point2D
  netKey: string
}

interface FlowTerminal {
  item: FlowItem
  equivalentItems: FlowItem[]
  candidates: Array<{ node: number; connectorPoints: Point2D[] }>
}

interface FlowRoute {
  item: FlowItem
  points: Point2D[]
  segments: RoutedSegment[]
}

interface DirectionGroupResult {
  routes: FlowRoute[]
  usedNodes: number[]
  unmatchedItems: FlowItem[]
}

interface FlowGrid {
  boundary: PreparedBus["sharedBoundary"]
  step: number
  columnCount: number
  rowCount: number
  nodeCount: number
  points: Point2D[]
  obstacleFreeNodes: Uint8Array
  neighbors: number[][]
}

interface FlowEdge {
  to: number
  reverseIndex: number
  capacity: number
  initialCapacity: number
  gridNode?: number
  isSink?: boolean
}

const EPSILON = 1e-9
const OBSTACLE_BIN_SIZE = 1
const FANOUT_FLOW_DEBUG_ENABLED =
  (
    globalThis as typeof globalThis & {
      process?: {
        env?: {
          FANOUT_FLOW_DEBUG?: string
        }
      }
    }
  ).process?.env?.FANOUT_FLOW_DEBUG === "1"

function getNetKey(connection: PreparedConnection): string {
  const simpleRouteConnection =
    connection.connection as typeof connection.connection & {
      netConnectionName?: string
    }
  const connectivityNet = connection.sourceObstacle.connectedTo.find(
    (connectionName) => connectionName.startsWith("connectivity_net"),
  )
  return (
    connectivityNet ??
    simpleRouteConnection.netConnectionName ??
    connection.connection.name.replace(/::fanout:\d+$/, "")
  )
}

function obstacleBelongsToItem(obstacle: Obstacle, item: FlowItem): boolean {
  return (
    obstacle === item.connection.sourceObstacle ||
    obstacle.connectedTo.includes(item.connection.connection.name) ||
    obstacle.connectedTo.includes(item.netKey)
  )
}

function connectWith45DegreeSegments(start: Point2D, end: Point2D): Point2D[] {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const absoluteX = Math.abs(deltaX)
  const absoluteY = Math.abs(deltaY)
  if (
    absoluteX < EPSILON ||
    absoluteY < EPSILON ||
    Math.abs(absoluteX - absoluteY) < EPSILON
  ) {
    return [start, end]
  }
  if (absoluteX > absoluteY) {
    return [
      start,
      {
        x: start.x + Math.sign(deltaX) * absoluteY,
        y: end.y,
      },
      end,
    ]
  }
  return [
    start,
    {
      x: end.x,
      y: start.y + Math.sign(deltaY) * absoluteX,
    },
    end,
  ]
}

function enforceStraightOr45DegreeSegments(points: Point2D[]): Point2D[] {
  if (points.length < 2) return points
  const normalized = [points[0]!]
  for (const end of points.slice(1)) {
    const start = normalized.at(-1)!
    const deltaX = Math.abs(end.x - start.x)
    const deltaY = Math.abs(end.y - start.y)
    if (
      deltaX < EPSILON ||
      deltaY < EPSILON ||
      Math.abs(deltaX - deltaY) < EPSILON
    ) {
      normalized.push(end)
      continue
    }
    normalized.push(
      ...connectWith45DegreeSegments(end, start).reverse().slice(1),
    )
  }
  return compressPath(normalized)
}

function compressPath(points: Point2D[]): Point2D[] {
  if (points.length < 3) return points
  const compressed = [points[0]!]
  for (let index = 1; index < points.length - 1; index++) {
    const previous = compressed.at(-1)!
    const current = points[index]!
    const next = points[index + 1]!
    if (
      Math.sign(current.x - previous.x) !== Math.sign(next.x - current.x) ||
      Math.sign(current.y - previous.y) !== Math.sign(next.y - current.y)
    ) {
      compressed.push(current)
    }
  }
  compressed.push(points.at(-1)!)
  return compressed
}

function chamferOrthogonalPolyline(
  points: Point2D[],
  requestedChamfer: number,
): Point2D[] {
  if (points.length < 3) return points
  const chamfered = [points[0]!]
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!
    const corner = points[index]!
    const next = points[index + 1]!
    const incomingLength = distance(previous, corner)
    const outgoingLength = distance(corner, next)
    if (incomingLength < EPSILON || outgoingLength < EPSILON) continue
    const incoming = {
      x: (corner.x - previous.x) / incomingLength,
      y: (corner.y - previous.y) / incomingLength,
    }
    const outgoing = {
      x: (next.x - corner.x) / outgoingLength,
      y: (next.y - corner.y) / outgoingLength,
    }
    if (Math.abs(incoming.x * outgoing.x + incoming.y * outgoing.y) > 1e-6) {
      chamfered.push(corner)
      continue
    }
    const chamfer = Math.min(
      requestedChamfer,
      incomingLength / 2,
      outgoingLength / 2,
    )
    chamfered.push({
      x: corner.x - incoming.x * chamfer,
      y: corner.y - incoming.y * chamfer,
    })
    chamfered.push({
      x: corner.x + outgoing.x * chamfer,
      y: corner.y + outgoing.y * chamfer,
    })
  }
  chamfered.push(points.at(-1)!)
  return compressPath(chamfered)
}

function getSegments(points: Point2D[], traceWidth: number): RoutedSegment[] {
  const segments: RoutedSegment[] = []
  for (let index = 1; index < points.length; index++) {
    if (distance(points[index - 1]!, points[index]!) < EPSILON) continue
    segments.push({
      start: points[index - 1]!,
      end: points[index]!,
      width: traceWidth,
      layer: "top",
    })
  }
  return segments
}

class Dinic {
  readonly edges: FlowEdge[][]
  private readonly levels: Int32Array
  private readonly nextEdges: Int32Array

  constructor(nodeCount: number) {
    this.edges = Array.from({ length: nodeCount }, () => [])
    this.levels = new Int32Array(nodeCount)
    this.nextEdges = new Int32Array(nodeCount)
  }

  addEdge(
    from: number,
    to: number,
    capacity: number,
    metadata: Pick<FlowEdge, "gridNode" | "isSink"> = {},
  ): void {
    const forward: FlowEdge = {
      to,
      reverseIndex: this.edges[to]!.length,
      capacity,
      initialCapacity: capacity,
      ...metadata,
    }
    const reverse: FlowEdge = {
      to: from,
      reverseIndex: this.edges[from]!.length,
      capacity: 0,
      initialCapacity: 0,
    }
    this.edges[from]!.push(forward)
    this.edges[to]!.push(reverse)
  }

  private buildLevels(source: number, sink: number): boolean {
    this.levels.fill(-1)
    const queue = new Int32Array(this.edges.length)
    let head = 0
    let tail = 0
    queue[tail++] = source
    this.levels[source] = 0
    while (head < tail) {
      const node = queue[head++]!
      for (const edge of this.edges[node]!) {
        if (edge.capacity <= 0 || this.levels[edge.to] >= 0) continue
        this.levels[edge.to] = this.levels[node]! + 1
        queue[tail++] = edge.to
      }
    }
    return this.levels[sink] >= 0
  }

  private sendFlow(node: number, sink: number): number {
    if (node === sink) return 1
    for (
      let edgeIndex = this.nextEdges[node]!;
      edgeIndex < this.edges[node]!.length;
      edgeIndex++, this.nextEdges[node] = edgeIndex
    ) {
      const edge = this.edges[node]![edgeIndex]!
      if (
        edge.capacity <= 0 ||
        this.levels[edge.to] !== this.levels[node]! + 1
      ) {
        continue
      }
      const sent = this.sendFlow(edge.to, sink)
      if (sent === 0) continue
      edge.capacity -= sent
      this.edges[edge.to]![edge.reverseIndex]!.capacity += sent
      return sent
    }
    return 0
  }

  maximumFlow(source: number, sink: number, limit: number): number {
    let flow = 0
    while (flow < limit && this.buildLevels(source, sink)) {
      this.nextEdges.fill(0)
      while (flow < limit) {
        const sent = this.sendFlow(source, sink)
        if (sent === 0) break
        flow += sent
      }
    }
    return flow
  }
}

function createFlowGrid(params: {
  boundary: PreparedBus["sharedBoundary"]
  obstacles: Obstacle[]
  traceWidth: number
  clearance: number
}): FlowGrid {
  const { boundary, obstacles, traceWidth, clearance } = params
  const step = traceWidth + clearance
  const columnCount = Math.round((boundary.maxX - boundary.minX) / step) + 1
  const rowCount = Math.round((boundary.maxY - boundary.minY) / step) + 1
  const nodeCount = columnCount * rowCount
  const points = Array.from({ length: nodeCount }, (_, node) => ({
    x: boundary.minX + (node % columnCount) * step,
    y: boundary.minY + Math.floor(node / columnCount) * step,
  }))
  const requiredObstacleDistance = traceWidth / 2 + clearance
  const obstacleIndexesByBin = new Map<string, number[]>()
  for (
    let obstacleIndex = 0;
    obstacleIndex < obstacles.length;
    obstacleIndex++
  ) {
    const obstacle = obstacles[obstacleIndex]!
    const minBinX = Math.floor(
      (obstacle.center.x - obstacle.width / 2 - requiredObstacleDistance) /
        OBSTACLE_BIN_SIZE,
    )
    const maxBinX = Math.floor(
      (obstacle.center.x + obstacle.width / 2 + requiredObstacleDistance) /
        OBSTACLE_BIN_SIZE,
    )
    const minBinY = Math.floor(
      (obstacle.center.y - obstacle.height / 2 - requiredObstacleDistance) /
        OBSTACLE_BIN_SIZE,
    )
    const maxBinY = Math.floor(
      (obstacle.center.y + obstacle.height / 2 + requiredObstacleDistance) /
        OBSTACLE_BIN_SIZE,
    )
    for (let binX = minBinX; binX <= maxBinX; binX++) {
      for (let binY = minBinY; binY <= maxBinY; binY++) {
        const key = `${binX}:${binY}`
        const indexes = obstacleIndexesByBin.get(key) ?? []
        indexes.push(obstacleIndex)
        obstacleIndexesByBin.set(key, indexes)
      }
    }
  }
  const getNearbyObstacles = (first: Point2D, second = first): Obstacle[] => {
    const minBinX = Math.floor(Math.min(first.x, second.x) / OBSTACLE_BIN_SIZE)
    const maxBinX = Math.floor(Math.max(first.x, second.x) / OBSTACLE_BIN_SIZE)
    const minBinY = Math.floor(Math.min(first.y, second.y) / OBSTACLE_BIN_SIZE)
    const maxBinY = Math.floor(Math.max(first.y, second.y) / OBSTACLE_BIN_SIZE)
    const indexes = new Set<number>()
    for (let binX = minBinX; binX <= maxBinX; binX++) {
      for (let binY = minBinY; binY <= maxBinY; binY++) {
        for (const obstacleIndex of obstacleIndexesByBin.get(
          `${binX}:${binY}`,
        ) ?? []) {
          indexes.add(obstacleIndex)
        }
      }
    }
    return [...indexes].map((index) => obstacles[index]!)
  }
  const obstacleFreeNodes = new Uint8Array(nodeCount)
  for (let node = 0; node < nodeCount; node++) {
    const point = points[node]!
    if (
      getNearbyObstacles(point).every(
        (obstacle) =>
          distancePointToObstacle(point, obstacle) >=
          requiredObstacleDistance - EPSILON,
      )
    ) {
      obstacleFreeNodes[node] = 1
    }
  }
  const neighbors: number[][] = Array.from({ length: nodeCount }, () => [])
  for (let node = 0; node < nodeCount; node++) {
    if (!obstacleFreeNodes[node]) continue
    const column = node % columnCount
    const row = Math.floor(node / columnCount)
    for (const [deltaColumn, deltaRow] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const nextColumn = column + deltaColumn
      const nextRow = row + deltaRow
      if (nextColumn >= columnCount || nextRow >= rowCount) continue
      const nextNode = nextRow * columnCount + nextColumn
      if (!obstacleFreeNodes[nextNode]) continue
      const segment: RoutedSegment = {
        start: points[node]!,
        end: points[nextNode]!,
        width: traceWidth,
        layer: "top",
      }
      if (
        getNearbyObstacles(segment.start, segment.end).some(
          (obstacle) =>
            distanceSegmentToObstacle(segment, obstacle) <
            requiredObstacleDistance - EPSILON,
        )
      ) {
        continue
      }
      neighbors[node]!.push(nextNode)
      neighbors[nextNode]!.push(node)
    }
  }
  return {
    boundary,
    step,
    columnCount,
    rowCount,
    nodeCount,
    points,
    obstacleFreeNodes,
    neighbors,
  }
}

function routeDirectionGroup(params: {
  direction: FanoutDirection | "any"
  availableDirections?: ReadonlySet<FanoutDirection>
  items: FlowItem[]
  grid: FlowGrid
  obstacles: Obstacle[]
  traceWidth: number
  clearance: number
  occupiedNodes: Uint8Array
  acceptedSegments: RoutedSegment[]
  connectorSelectionOffset?: number
}): DirectionGroupResult | null {
  const {
    direction,
    availableDirections,
    items,
    grid,
    obstacles,
    traceWidth,
    clearance,
    occupiedNodes,
    acceptedSegments,
    connectorSelectionOffset = 0,
  } = params
  if (items.length === 0) {
    return { routes: [], usedNodes: [], unmatchedItems: [] }
  }
  const {
    boundary,
    step,
    columnCount,
    rowCount,
    nodeCount: gridNodeCount,
  } = grid
  const pointForNode = (node: number): Point2D => grid.points[node]!
  const requiredObstacleDistance = traceWidth / 2 + clearance
  const requiredRouteDistance = traceWidth + clearance
  const freeNodes = new Uint8Array(gridNodeCount)
  for (let node = 0; node < gridNodeCount; node++) {
    if (!occupiedNodes[node] && grid.obstacleFreeNodes[node]) {
      freeNodes[node] = 1
    }
  }
  const connectorIsClear = (points: Point2D[], item: FlowItem) => {
    const segments = getSegments(points, traceWidth)
    return (
      segments.every((segment) =>
        obstacles.every(
          (obstacle) =>
            obstacleBelongsToItem(obstacle, item) ||
            distanceSegmentToObstacle(segment, obstacle) >=
              requiredObstacleDistance - EPSILON,
        ),
      ) &&
      segments.every((segment) =>
        acceptedSegments.every(
          (acceptedSegment) =>
            distanceSegmentToSegment(
              segment.start,
              segment.end,
              acceptedSegment.start,
              acceptedSegment.end,
            ) >=
            requiredRouteDistance - EPSILON,
        ),
      )
    )
  }

  const equivalentItemsByKey = new Map<string, FlowItem[]>()
  for (const item of items) {
    const key = `${item.source.x.toFixed(6)}:${item.source.y.toFixed(6)}:${item.netKey}`
    const equivalents = equivalentItemsByKey.get(key) ?? []
    equivalents.push(item)
    equivalentItemsByKey.set(key, equivalents)
  }
  const offsetCandidates = Array.from({ length: 61 * 61 }, (_, index) => {
    const x = (index % 61) - 30
    const y = Math.floor(index / 61) - 30
    return { x, y, distanceSquared: x * x + y * y }
  }).sort((first, second) => first.distanceSquared - second.distanceSquared)
  const terminals: FlowTerminal[] = []
  for (const equivalentItems of equivalentItemsByKey.values()) {
    const item = equivalentItems[0]!
    const maxConnectorLength =
      Math.hypot(
        item.connection.sourceObstacle.width / 2,
        item.connection.sourceObstacle.height / 2,
      ) +
      clearance +
      step * 2
    const sourceColumn = Math.round((item.source.x - boundary.minX) / step)
    const sourceRow = Math.round((item.source.y - boundary.minY) / step)
    const candidates: FlowTerminal["candidates"] = []
    const candidateNodes = new Set<number>()
    for (const offset of offsetCandidates) {
      const column = sourceColumn + offset.x
      const row = sourceRow + offset.y
      if (column < 0 || column >= columnCount || row < 0 || row >= rowCount) {
        continue
      }
      const node = row * columnCount + column
      if (!freeNodes[node] || candidateNodes.has(node)) continue
      if (distance(item.source, pointForNode(node)) > maxConnectorLength) {
        continue
      }
      const connectorPoints = connectWith45DegreeSegments(
        item.source,
        pointForNode(node),
      )
      if (!connectorIsClear(connectorPoints, item)) continue
      candidateNodes.add(node)
      candidates.push({ node, connectorPoints })
      if (candidates.length >= 12) break
    }
    if (candidates.length === 0) return null
    terminals.push({ item, equivalentItems, candidates })
  }

  const selectedConnectorSegments: Array<{
    netKey: string
    segments: RoutedSegment[]
  }> = []
  for (const terminal of [...terminals].sort(
    (first, second) => first.candidates.length - second.candidates.length,
  )) {
    const candidateOffset =
      terminal.candidates.length === 0
        ? 0
        : connectorSelectionOffset % terminal.candidates.length
    const orderedCandidates = [
      ...terminal.candidates.slice(candidateOffset),
      ...terminal.candidates.slice(0, candidateOffset),
    ]
    const candidate = orderedCandidates.find((value) => {
      const segments = getSegments(value.connectorPoints, traceWidth)
      return selectedConnectorSegments.every(
        (selected) =>
          selected.netKey === terminal.item.netKey ||
          segments.every((segment) =>
            selected.segments.every(
              (otherSegment) =>
                distanceSegmentToSegment(
                  segment.start,
                  segment.end,
                  otherSegment.start,
                  otherSegment.end,
                ) >=
                requiredRouteDistance - EPSILON,
            ),
          ),
      )
    })
    if (!candidate) return null
    terminal.candidates = [candidate]
    selectedConnectorSegments.push({
      netKey: terminal.item.netKey,
      segments: getSegments(candidate.connectorPoints, traceWidth),
    })
  }

  const terminalNodes = new Set(
    terminals.map((terminal) => terminal.candidates[0]!.node),
  )
  for (const selected of selectedConnectorSegments) {
    for (const segment of selected.segments) {
      const minColumn = Math.max(
        0,
        Math.floor(
          (Math.min(segment.start.x, segment.end.x) -
            requiredRouteDistance -
            boundary.minX) /
            step,
        ),
      )
      const maxColumn = Math.min(
        columnCount - 1,
        Math.ceil(
          (Math.max(segment.start.x, segment.end.x) +
            requiredRouteDistance -
            boundary.minX) /
            step,
        ),
      )
      const minRow = Math.max(
        0,
        Math.floor(
          (Math.min(segment.start.y, segment.end.y) -
            requiredRouteDistance -
            boundary.minY) /
            step,
        ),
      )
      const maxRow = Math.min(
        rowCount - 1,
        Math.ceil(
          (Math.max(segment.start.y, segment.end.y) +
            requiredRouteDistance -
            boundary.minY) /
            step,
        ),
      )
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          const node = row * columnCount + column
          if (!freeNodes[node] || terminalNodes.has(node)) continue
          const point = pointForNode(node)
          if (
            distanceSegmentToSegment(segment.start, segment.end, point, point) <
            requiredRouteDistance - EPSILON
          ) {
            freeNodes[node] = 0
          }
        }
      }
    }
  }

  const source = 0
  const terminalStart = 1
  const gridInStart = terminalStart + terminals.length
  const gridOutStart = gridInStart + gridNodeCount
  const sink = gridOutStart + gridNodeCount
  const flow = new Dinic(sink + 1)
  for (
    let terminalIndex = 0;
    terminalIndex < terminals.length;
    terminalIndex++
  ) {
    const terminalNode = terminalStart + terminalIndex
    flow.addEdge(source, terminalNode, 1)
    for (const candidate of terminals[terminalIndex]!.candidates) {
      flow.addEdge(terminalNode, gridInStart + candidate.node, 1, {
        gridNode: candidate.node,
      })
    }
  }
  for (let node = 0; node < gridNodeCount; node++) {
    if (!freeNodes[node]) continue
    flow.addEdge(gridInStart + node, gridOutStart + node, 1)
    const column = node % columnCount
    const row = Math.floor(node / columnCount)
    for (const nextNode of grid.neighbors[node]!) {
      if (!freeNodes[nextNode]) continue
      flow.addEdge(gridOutStart + node, gridInStart + nextNode, 1, {
        gridNode: nextNode,
      })
    }
    const isTarget =
      (direction === "any" &&
        (((!availableDirections || availableDirections.has("left")) &&
          column === 0) ||
          ((!availableDirections || availableDirections.has("right")) &&
            column === columnCount - 1) ||
          ((!availableDirections || availableDirections.has("down")) &&
            row === 0) ||
          ((!availableDirections || availableDirections.has("up")) &&
            row === rowCount - 1))) ||
      (direction === "left" && column === 0) ||
      (direction === "right" && column === columnCount - 1) ||
      (direction === "down" && row === 0) ||
      (direction === "up" && row === rowCount - 1)
    if (isTarget) {
      flow.addEdge(gridOutStart + node, sink, 1, { isSink: true })
    }
  }
  const achievedFlow = flow.maximumFlow(source, sink, terminals.length)
  const terminalWasMatched = (terminalIndex: number) => {
    const terminalNode = terminalStart + terminalIndex
    return flow.edges[source]!.some(
      (edge) =>
        edge.to === terminalNode &&
        edge.initialCapacity === 1 &&
        edge.capacity === 0,
    )
  }
  if (achievedFlow !== terminals.length) {
    if (FANOUT_FLOW_DEBUG_ENABLED) {
      const unmatchedConnections = terminals.flatMap((terminal, index) => {
        const terminalNode = terminalStart + index
        return terminalWasMatched(index)
          ? []
          : [terminal.item.connection.connection.name]
      })
      console.error("single-layer flow group failed", {
        direction,
        achievedFlow,
        requiredFlow: terminals.length,
        unmatchedConnections,
      })
    }
  }

  const routes: FlowRoute[] = []
  const usedNodes: number[] = []
  const unmatchedItems: FlowItem[] = []
  for (
    let terminalIndex = 0;
    terminalIndex < terminals.length;
    terminalIndex++
  ) {
    const terminal = terminals[terminalIndex]!
    if (!terminalWasMatched(terminalIndex)) {
      unmatchedItems.push(...terminal.equivalentItems)
      continue
    }
    const terminalNode = terminalStart + terminalIndex
    const candidateEdge = flow.edges[terminalNode]!.find(
      (edge) =>
        edge.initialCapacity === 1 &&
        edge.capacity === 0 &&
        edge.gridNode !== undefined,
    )
    if (candidateEdge?.gridNode === undefined) return null
    const candidate = terminal.candidates.find(
      (value) => value.node === candidateEdge.gridNode,
    )
    if (!candidate) return null
    const gridPoints: Point2D[] = [pointForNode(candidate.node)]
    let node = candidate.node
    const routeNodes = [node]
    for (let guard = 0; guard <= gridNodeCount; guard++) {
      const outNode = gridOutStart + node
      const nextEdge = flow.edges[outNode]!.find(
        (edge) =>
          edge.initialCapacity === 1 &&
          edge.capacity === 0 &&
          (edge.gridNode !== undefined || edge.isSink),
      )
      if (!nextEdge) return null
      if (nextEdge.isSink) break
      if (nextEdge.gridNode === undefined) return null
      node = nextEdge.gridNode
      routeNodes.push(node)
      gridPoints.push(pointForNode(node))
    }
    usedNodes.push(...routeNodes)
    const unchamferedPoints = compressPath([
      ...candidate.connectorPoints,
      ...gridPoints.slice(1),
    ])
    const points = enforceStraightOr45DegreeSegments(
      chamferOrthogonalPolyline(unchamferedPoints, step / 2),
    )
    const segments = getSegments(points, traceWidth)
    for (const item of terminal.equivalentItems) {
      routes.push({ item, points, segments })
    }
  }
  return { routes, usedNodes, unmatchedItems }
}

function buildPlan(route: FlowRoute, traceWidth: number): FanoutRoutePlan {
  const { item, points, segments } = route
  const traceRoute: SimplifiedPcbTrace["route"] = points.map(
    (point, index) => ({
      route_type: "wire",
      x: point.x,
      y: point.y,
      width: traceWidth,
      layer: "top",
      ...(index === 0 && item.connection.sourcePoint.pcb_port_id
        ? { start_pcb_port_id: item.connection.sourcePoint.pcb_port_id }
        : {}),
    }),
  )
  return {
    busId: item.bus.busId,
    connectionName: item.connection.connection.name,
    connectionIndex: item.connection.connectionIndex,
    sourcePointIndex: item.connection.sourcePointIndex,
    sourcePoint: item.connection.sourcePoint,
    sourceObstacle: item.connection.sourceObstacle,
    sourceLayer: item.connection.sourceLayer,
    targetLayer: "top",
    termination: item.bus.termination,
    direction: item.bus.direction,
    exitPoint: points.at(-1)!,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: `fanout:${item.connection.connection.name}`,
      connection_name: item.connection.connection.name,
      connectsTo: [
        item.connection.connection.name,
        item.netKey,
        ...(item.connection.sourcePoint.pointId
          ? [item.connection.sourcePoint.pointId]
          : []),
        ...(item.connection.sourcePoint.pcb_port_id
          ? [item.connection.sourcePoint.pcb_port_id]
          : []),
      ],
      route: traceRoute,
    },
    segments,
    length: segments.reduce(
      (total, segment) => total + distance(segment.start, segment.end),
      0,
    ),
  }
}

function getConnectorVariants(start: Point2D, end: Point2D): Point2D[][] {
  const first = connectWith45DegreeSegments(start, end)
  const second = connectWith45DegreeSegments(end, start).reverse()
  return first.length === second.length &&
    first.every((point, index) => distance(point, second[index]!) < EPSILON)
    ? [first]
    : [first, second]
}

function plansHaveRequiredClearance(params: {
  plans: FanoutRoutePlan[]
  items: FlowItem[]
  obstacles: Obstacle[]
  traceWidth: number
  clearance: number
}): boolean {
  const { plans, items, obstacles, traceWidth, clearance } = params
  const netKeyByConnectionName = new Map(
    items.map((item) => [item.connection.connection.name, item.netKey]),
  )
  const uniqueSegmentsByNet = new Map<string, RoutedSegment[]>()
  const segmentKeysByNet = new Map<string, Set<string>>()
  for (const plan of plans) {
    const netKey = netKeyByConnectionName.get(plan.connectionName)!
    const segments = uniqueSegmentsByNet.get(netKey) ?? []
    const segmentKeys = segmentKeysByNet.get(netKey) ?? new Set<string>()
    for (const segment of plan.segments) {
      const endpoints = [segment.start, segment.end]
        .map((point) => `${point.x.toFixed(6)}:${point.y.toFixed(6)}`)
        .sort()
      const key = endpoints.join(":")
      if (segmentKeys.has(key)) continue
      segmentKeys.add(key)
      segments.push(segment)
    }
    uniqueSegmentsByNet.set(netKey, segments)
    segmentKeysByNet.set(netKey, segmentKeys)
  }
  const requiredObstacleDistance = traceWidth / 2 + clearance
  for (const [netKey, segments] of uniqueSegmentsByNet) {
    for (const segment of segments) {
      for (const obstacle of obstacles) {
        if (
          obstacle.connectedTo.includes(netKey) ||
          distanceSegmentToObstacle(segment, obstacle) >=
            requiredObstacleDistance - EPSILON
        ) {
          continue
        }
        if (FANOUT_FLOW_DEBUG_ENABLED) {
          console.error("single-layer route violates obstacle clearance", {
            netKey,
            segment,
            obstacleId: obstacle.obstacleId,
            distance: distanceSegmentToObstacle(segment, obstacle),
            requiredObstacleDistance,
          })
        }
        return false
      }
    }
  }
  const requiredRouteDistance = traceWidth + clearance
  const entries = [...uniqueSegmentsByNet]
  for (let firstIndex = 0; firstIndex < entries.length; firstIndex++) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < entries.length;
      secondIndex++
    ) {
      for (const first of entries[firstIndex]![1]) {
        for (const second of entries[secondIndex]![1]) {
          if (
            distanceSegmentToSegment(
              first.start,
              first.end,
              second.start,
              second.end,
            ) <
            requiredRouteDistance - EPSILON
          ) {
            if (FANOUT_FLOW_DEBUG_ENABLED) {
              console.error("single-layer routes violate copper clearance", {
                firstNetKey: entries[firstIndex]![0],
                secondNetKey: entries[secondIndex]![0],
                first,
                second,
                distance: distanceSegmentToSegment(
                  first.start,
                  first.end,
                  second.start,
                  second.end,
                ),
                requiredRouteDistance,
              })
            }
            return false
          }
        }
      }
    }
  }
  return true
}

function getDirectionForBoundaryPoint(
  point: Point2D,
  boundary: PreparedBus["sharedBoundary"],
): FanoutDirection | null {
  if (Math.abs(point.x - boundary.minX) < EPSILON) return "left"
  if (Math.abs(point.x - boundary.maxX) < EPSILON) return "right"
  if (Math.abs(point.y - boundary.minY) < EPSILON) return "down"
  if (Math.abs(point.y - boundary.maxY) < EPSILON) return "up"
  return null
}

function routeWithAdaptiveExits(params: {
  items: FlowItem[]
  grid: FlowGrid
  obstacles: Obstacle[]
  traceWidth: number
  clearance: number
  availableBoundaryRegions?: AvailableBoundaryRegion[]
}): FanoutRoutePlan[] | null {
  const {
    items,
    grid,
    obstacles,
    traceWidth,
    clearance,
    availableBoundaryRegions,
  } = params
  const availableDirections = availableBoundaryRegions
    ? new Set(availableBoundaryRegions.map((region) => region.direction))
    : undefined
  const mergeItems = new Set(
    items.filter(
      (item) =>
        item.connection.sourceObstacle.width > 2 &&
        item.connection.sourceObstacle.height > 2,
    ),
  )
  let unrestricted: ReturnType<typeof routeDirectionGroup> = null
  for (let mergeRound = 0; mergeRound < 4; mergeRound++) {
    const directlyRoutedItems = items.filter((item) => !mergeItems.has(item))
    let bestResult: DirectionGroupResult | null = null
    for (
      let connectorSelectionOffset = 0;
      connectorSelectionOffset < 4;
      connectorSelectionOffset++
    ) {
      const result = routeDirectionGroup({
        direction: "any",
        availableDirections,
        items: directlyRoutedItems,
        grid,
        obstacles,
        traceWidth,
        clearance,
        occupiedNodes: new Uint8Array(grid.nodeCount),
        acceptedSegments: [],
        connectorSelectionOffset,
      })
      if (!result) continue
      if (!bestResult || result.routes.length > bestResult.routes.length) {
        bestResult = result
      }
      if (result.routes.length === directlyRoutedItems.length) break
    }
    if (!bestResult) return null
    if (bestResult.routes.length === directlyRoutedItems.length) {
      unrestricted = bestResult
      break
    }
    const directlyRoutedNetCounts = new Map<string, number>()
    for (const item of directlyRoutedItems) {
      directlyRoutedNetCounts.set(
        item.netKey,
        (directlyRoutedNetCounts.get(item.netKey) ?? 0) + 1,
      )
    }
    let addedMergeItem = false
    for (const item of bestResult.unmatchedItems) {
      if ((directlyRoutedNetCounts.get(item.netKey) ?? 0) < 2) continue
      mergeItems.add(item)
      addedMergeItem = true
    }
    if (!addedMergeItem) return null
  }
  if (!unrestricted) return null
  const routes = [...unrestricted.routes]
  const requiredObstacleDistance = traceWidth / 2 + clearance
  const requiredRouteDistance = traceWidth + clearance
  for (const mergeItem of mergeItems) {
    const candidates = routes
      .filter((route) => route.item.netKey === mergeItem.netKey)
      .flatMap((route) =>
        route.points.map((point, pointIndex) => ({
          route,
          point,
          pointIndex,
        })),
      )
      .sort(
        (first, second) =>
          Number(
            second.route.item.bus.componentId === mergeItem.bus.componentId,
          ) -
            Number(
              first.route.item.bus.componentId === mergeItem.bus.componentId,
            ) ||
          distance(mergeItem.source, first.point) -
            distance(mergeItem.source, second.point),
      )
    let mergedRoute: FlowRoute | null = null
    for (const candidate of candidates) {
      for (const connectorPoints of getConnectorVariants(
        mergeItem.source,
        candidate.point,
      )) {
        const connectorSegments = getSegments(connectorPoints, traceWidth)
        const clearsObstacles = connectorSegments.every((segment) =>
          obstacles.every(
            (obstacle) =>
              obstacleBelongsToItem(obstacle, mergeItem) ||
              distanceSegmentToObstacle(segment, obstacle) >=
                requiredObstacleDistance - EPSILON,
          ),
        )
        const clearsRoutes = connectorSegments.every((segment) =>
          routes.every(
            (route) =>
              route.item.netKey === mergeItem.netKey ||
              route.segments.every(
                (otherSegment) =>
                  distanceSegmentToSegment(
                    segment.start,
                    segment.end,
                    otherSegment.start,
                    otherSegment.end,
                  ) >=
                  requiredRouteDistance - EPSILON,
              ),
          ),
        )
        if (!clearsObstacles || !clearsRoutes) continue
        const points = enforceStraightOr45DegreeSegments(
          compressPath([
            ...connectorPoints,
            ...candidate.route.points.slice(candidate.pointIndex + 1),
          ]),
        )
        mergedRoute = {
          item: mergeItem,
          points,
          segments: getSegments(points, traceWidth),
        }
        break
      }
      if (mergedRoute) break
    }
    if (!mergedRoute) return null
    routes.push(mergedRoute)
  }
  const plans = routes.map((route) => buildPlan(route, traceWidth))
  if (
    !plansHaveRequiredClearance({
      plans,
      items,
      obstacles,
      traceWidth,
      clearance,
    })
  ) {
    if (FANOUT_FLOW_DEBUG_ENABLED) {
      console.error("single-layer adaptive exits failed exact clearance")
    }
    return null
  }
  for (const plan of plans) {
    const direction = getDirectionForBoundaryPoint(
      plan.exitPoint,
      grid.boundary,
    )
    if (
      !direction ||
      (availableDirections && !availableDirections.has(direction))
    ) {
      return null
    }
    const item = items.find(
      (candidate) =>
        candidate.connection.connection.name === plan.connectionName,
    )!
    item.bus.direction = direction
    const compatibleRegions = availableBoundaryRegions?.filter(
      (region) => region.direction === direction,
    )
    const exitCoordinate =
      direction === "up" || direction === "down"
        ? plan.exitPoint.x
        : plan.exitPoint.y
    item.bus.preferredExit =
      compatibleRegions?.toSorted(
        (first, second) =>
          Math.abs(exitCoordinate - getRegionAnchor(first, grid.boundary)) -
          Math.abs(exitCoordinate - getRegionAnchor(second, grid.boundary)),
      )[0]?.preferredExit ??
      (direction === "up" ? "top" : direction === "down" ? "bottom" : direction)
    plan.direction = direction
  }
  const planByConnectionName = new Map(
    plans.map((plan) => [plan.connectionName, plan]),
  )
  return items.map(
    (item) => planByConnectionName.get(item.connection.connection.name)!,
  )
}

export function routeSingleLayerWithAdaptiveExits(
  params: FlowRoutingParams,
): FanoutRoutePlan[] | null {
  const { srj, buses, traceWidth, clearance, availableBoundaryRegions } = params
  if (buses.some((bus) => bus.connections.length !== 1)) return null
  const items = buses.flatMap((bus) =>
    bus.connections.map(
      (connection): FlowItem => ({
        bus,
        connection,
        source: {
          x: connection.sourcePoint.x,
          y: connection.sourcePoint.y,
        },
        netKey: getNetKey(connection),
      }),
    ),
  )
  const topObstacles = srj.obstacles.filter((obstacle) =>
    obstacle.layers.includes("top"),
  )
  const boundary = buses[0]?.sharedBoundary
  if (!boundary) return []
  const grid = createFlowGrid({
    boundary,
    obstacles: topObstacles,
    traceWidth,
    clearance,
  })
  if (FANOUT_FLOW_DEBUG_ENABLED) {
    console.error("single-layer adaptive-exit grid ready", {
      nodeCount: grid.nodeCount,
    })
  }
  const adaptivePlans = routeWithAdaptiveExits({
    items,
    grid,
    obstacles: topObstacles,
    traceWidth,
    clearance,
    availableBoundaryRegions,
  })
  if (adaptivePlans) return adaptivePlans
  return null
}
