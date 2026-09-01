import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getCornerBandSide, getDirectionForExitEdge } from "./boundary-exit"
import { createFanoutOutputIds } from "./fanout-output-ids"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "./geometry"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import { getViaSpanLayers } from "./layer-names"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "./net-identity"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
  RoutedVia,
} from "./types"

const EPSILON = 1e-7
const MAX_GRID_NODE_COUNT = 120_000
const MAX_EXPANDED_STATE_COUNT = 240_000
const MAX_CONNECTOR_COUNT = 24
const CONNECTOR_RADIUS_IN_STEPS = 3.25
const MAX_DIVERSIFIED_PATH_ATTEMPTS = 5
const DEFAULT_JOINT_ROUTE_BEAM_WIDTH = 6
const BLOCKING_SEGMENT_CELL_SIZE = 0.5
const MAX_CELLS_PER_BLOCKING_SEGMENT = 4_096
const MAX_CELLS_PER_BLOCKING_SEGMENT_QUERY = 16_384

export interface ViaMinimalWindingTerminal {
  connection: PreparedConnection
  viaPoint: Point2D
  exitPoint: Point2D
}

export interface ViaMinimalWindingReservedVia {
  connectionName: string
  via: Pick<RoutedVia, "center" | "diameter" | "spanLayers">
}

/**
 * Alternative through-via sites for a connection whose future routing
 * capacity should be preserved when possible. These are a search preference,
 * not hard obstacles; callers must still validate the completed route.
 */
export interface ViaMinimalWindingSoftViaCapacityGroup {
  connectionIndex: number
  /** Connections sharing this candidate pool, for diagnostics and callers. */
  connectionIndexes?: readonly number[]
  points: readonly Point2D[]
  /** Defaults to one. Hall groups can require multiple distinct survivors. */
  minimumRemainingPointCount?: number
}

export interface RouteViaMinimalWindingParams {
  srj: SimpleRouteJson
  bus: PreparedBus
  targetLayer: string
  terminals: ViaMinimalWindingTerminal[]
  acceptedPlans: FanoutRoutePlan[]
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  allowBlindAndBuriedVias?: boolean
  allowSameNetMerges?: boolean
  maximumRouteOrderAttempts?: number
  reservedVias?: readonly ViaMinimalWindingReservedVia[]
  softViaCapacityGroups?: readonly ViaMinimalWindingSoftViaCapacityGroup[]
  /** Use a finer uniform grid for narrow channels between reserved vias. */
  gridStepDivisor?: 1 | 2
  /** Bias bounded fixed-site searches toward the remote target band. */
  preferTargetDirectedLaneBias?: boolean
  /** Shared mutable cap for dense callers spanning multiple A* attempts. */
  expandedStateBudget?: { remaining: number; exhausted?: boolean }
  /** Opt into bounded path/order backtracking after the legacy greedy pass. */
  enableJointRouteSearch?: boolean
}

interface GridNode {
  point: Point2D
  column: number
  row: number
}

interface ConnectorCandidate {
  nodeIndex: number
  points: Point2D[]
  radialDistance: number
  length: number
}

interface WindingPathCandidate {
  points: Point2D[]
  physicalLength: number
}

export interface BlockingSegment {
  connectionName: string
  segment: RoutedSegment
}

interface IndexedBlockingSegment {
  blocker: BlockingSegment
  minX: number
  maxX: number
  minY: number
  maxY: number
  halfWidth: number
}

/** Conservative broad phase; exact segment distance remains authoritative. */
export class BlockingSegmentSpatialIndex {
  private readonly segmentsByMinX: IndexedBlockingSegment[]
  private readonly segmentIndicesByColumnAndRow = new Map<
    number,
    Map<number, number[]>
  >()
  private readonly globallyQueriedSegmentIndices: number[] = []

  constructor(blockers: readonly BlockingSegment[]) {
    this.segmentsByMinX = blockers
      .map((blocker) => ({
        blocker,
        minX: Math.min(blocker.segment.start.x, blocker.segment.end.x),
        maxX: Math.max(blocker.segment.start.x, blocker.segment.end.x),
        minY: Math.min(blocker.segment.start.y, blocker.segment.end.y),
        maxY: Math.max(blocker.segment.start.y, blocker.segment.end.y),
        halfWidth: blocker.segment.width / 2,
      }))
      .toSorted((first, second) => first.minX - second.minX)

    for (const [segmentIndex, indexed] of this.segmentsByMinX.entries()) {
      const cellRange = this.getCellRange(
        indexed.minX - indexed.halfWidth,
        indexed.maxX + indexed.halfWidth,
        indexed.minY - indexed.halfWidth,
        indexed.maxY + indexed.halfWidth,
      )
      if (
        cellRange === null ||
        cellRange.cellCount > MAX_CELLS_PER_BLOCKING_SEGMENT
      ) {
        this.globallyQueriedSegmentIndices.push(segmentIndex)
        continue
      }

      for (
        let column = cellRange.minColumn;
        column <= cellRange.maxColumn;
        column++
      ) {
        let indicesByRow = this.segmentIndicesByColumnAndRow.get(column)
        if (!indicesByRow) {
          indicesByRow = new Map()
          this.segmentIndicesByColumnAndRow.set(column, indicesByRow)
        }
        for (let row = cellRange.minRow; row <= cellRange.maxRow; row++) {
          const segmentIndices = indicesByRow.get(row)
          if (segmentIndices) {
            segmentIndices.push(segmentIndex)
          } else {
            indicesByRow.set(row, [segmentIndex])
          }
        }
      }
    }
  }

  querySegment(segment: RoutedSegment, clearance: number): BlockingSegment[] {
    const queryMargin = Math.max(0, segment.width / 2 + clearance)
    const minX = Math.min(segment.start.x, segment.end.x) - queryMargin
    const maxX = Math.max(segment.start.x, segment.end.x) + queryMargin
    const minY = Math.min(segment.start.y, segment.end.y) - queryMargin
    const maxY = Math.max(segment.start.y, segment.end.y) + queryMargin
    const cellRange = this.getCellRange(minX, maxX, minY, maxY)
    if (
      cellRange === null ||
      cellRange.cellCount > MAX_CELLS_PER_BLOCKING_SEGMENT_QUERY
    ) {
      return this.queryAllSegmentsByBounds(minX, maxX, minY, maxY)
    }

    const candidateIndices = new Set(this.globallyQueriedSegmentIndices)
    for (
      let column = cellRange.minColumn;
      column <= cellRange.maxColumn;
      column++
    ) {
      const indicesByRow = this.segmentIndicesByColumnAndRow.get(column)
      if (!indicesByRow) continue
      for (let row = cellRange.minRow; row <= cellRange.maxRow; row++) {
        const segmentIndices = indicesByRow.get(row)
        if (!segmentIndices) continue
        for (const segmentIndex of segmentIndices) {
          candidateIndices.add(segmentIndex)
        }
      }
    }

    return [...candidateIndices]
      .toSorted((first, second) => first - second)
      .flatMap((segmentIndex) => {
        const indexed = this.segmentsByMinX[segmentIndex]!
        return this.segmentBoundsOverlapQuery(indexed, minX, maxX, minY, maxY)
          ? [indexed.blocker]
          : []
      })
  }

  private getCellRange(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ): {
    minColumn: number
    maxColumn: number
    minRow: number
    maxRow: number
    cellCount: number
  } | null {
    if (![minX, maxX, minY, maxY].every(Number.isFinite)) return null

    const minColumn = Math.floor(minX / BLOCKING_SEGMENT_CELL_SIZE)
    const maxColumn = Math.floor(maxX / BLOCKING_SEGMENT_CELL_SIZE)
    const minRow = Math.floor(minY / BLOCKING_SEGMENT_CELL_SIZE)
    const maxRow = Math.floor(maxY / BLOCKING_SEGMENT_CELL_SIZE)
    if (![minColumn, maxColumn, minRow, maxRow].every(Number.isSafeInteger)) {
      return null
    }
    const columnCount = maxColumn - minColumn + 1
    const rowCount = maxRow - minRow + 1
    if (columnCount <= 0 || rowCount <= 0) return null

    return {
      minColumn,
      maxColumn,
      minRow,
      maxRow,
      cellCount: columnCount * rowCount,
    }
  }

  private segmentBoundsOverlapQuery(
    indexed: IndexedBlockingSegment,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ): boolean {
    return !(
      indexed.maxX + indexed.halfWidth < minX ||
      indexed.minX - indexed.halfWidth > maxX ||
      indexed.maxY + indexed.halfWidth < minY ||
      indexed.minY - indexed.halfWidth > maxY
    )
  }

  private queryAllSegmentsByBounds(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
  ): BlockingSegment[] {
    if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
      return this.segmentsByMinX.map((indexed) => indexed.blocker)
    }
    return this.segmentsByMinX.flatMap((indexed) =>
      this.segmentBoundsOverlapQuery(indexed, minX, maxX, minY, maxY)
        ? [indexed.blocker]
        : [],
    )
  }
}

interface BlockingVia {
  connectionName: string
  via: Pick<RoutedVia, "center" | "diameter" | "spanLayers">
}

interface IndexedObstacle {
  obstacle: Obstacle
  minX: number
  maxX: number
  minY: number
  maxY: number
  xRadius: number
}

type ShapeAwareObstacle = Obstacle & {
  shape?: "circle"
  ccwRotationDegrees?: number
}

function getObstacleAxisAlignedBounds(
  obstacle: Obstacle,
): Omit<IndexedObstacle, "obstacle"> {
  const shapeAwareObstacle = obstacle as ShapeAwareObstacle
  if (shapeAwareObstacle.shape === "circle") {
    const radius = obstacle.width / 2
    return {
      minX: obstacle.center.x - radius,
      maxX: obstacle.center.x + radius,
      minY: obstacle.center.y - radius,
      maxY: obstacle.center.y + radius,
      xRadius: radius,
    }
  }

  const rotationRadians =
    ((shapeAwareObstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180
  const absoluteCosine = Math.abs(Math.cos(rotationRadians))
  const absoluteSine = Math.abs(Math.sin(rotationRadians))
  const halfWidth = obstacle.width / 2
  const halfHeight = obstacle.height / 2
  const xRadius = absoluteCosine * halfWidth + absoluteSine * halfHeight
  const yRadius = absoluteSine * halfWidth + absoluteCosine * halfHeight
  return {
    minX: obstacle.center.x - xRadius,
    maxX: obstacle.center.x + xRadius,
    minY: obstacle.center.y - yRadius,
    maxY: obstacle.center.y + yRadius,
    xRadius,
  }
}

/**
 * X-sorted broad phase for exact segment-to-obstacle clearance checks.
 * Rotation-aware bounds make the query conservative; callers still use the
 * shape-aware distance function to decide whether copper is actually blocked.
 */
export class ObstacleSpatialIndex {
  private readonly obstaclesByCenterX: IndexedObstacle[]
  private readonly maximumXRadius: number

  constructor(obstacles: readonly Obstacle[]) {
    this.obstaclesByCenterX = obstacles
      .map((obstacle) => ({
        obstacle,
        ...getObstacleAxisAlignedBounds(obstacle),
      }))
      .toSorted(
        (first, second) => first.obstacle.center.x - second.obstacle.center.x,
      )
    this.maximumXRadius = this.obstaclesByCenterX.reduce(
      (maximum, obstacle) => Math.max(maximum, obstacle.xRadius),
      0,
    )
  }

  querySegment(segment: RoutedSegment, margin: number): Obstacle[] {
    const segmentMinX = Math.min(segment.start.x, segment.end.x)
    const segmentMaxX = Math.max(segment.start.x, segment.end.x)
    const segmentMinY = Math.min(segment.start.y, segment.end.y)
    const segmentMaxY = Math.max(segment.start.y, segment.end.y)
    const minimumCenterX = segmentMinX - margin - this.maximumXRadius
    const maximumCenterX = segmentMaxX + margin + this.maximumXRadius
    let low = 0
    let high = this.obstaclesByCenterX.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (this.obstaclesByCenterX[middle]!.obstacle.center.x < minimumCenterX) {
        low = middle + 1
      } else {
        high = middle
      }
    }

    const candidates: Obstacle[] = []
    for (
      let obstacleIndex = low;
      obstacleIndex < this.obstaclesByCenterX.length;
      obstacleIndex++
    ) {
      const indexedObstacle = this.obstaclesByCenterX[obstacleIndex]!
      if (indexedObstacle.obstacle.center.x > maximumCenterX) break
      if (
        indexedObstacle.maxX < segmentMinX - margin ||
        indexedObstacle.minX > segmentMaxX + margin ||
        indexedObstacle.maxY < segmentMinY - margin ||
        indexedObstacle.minY > segmentMaxY + margin
      ) {
        continue
      }
      candidates.push(indexedObstacle.obstacle)
    }
    return candidates
  }
}

export function* iterateUniqueRouteOrders<T>(params: {
  initialOrderFactories: ReadonlyArray<() => readonly T[]>
  rotationBase: readonly T[]
  getItemKey: (item: T) => string
  maximumOrderCount?: number
}): Generator<readonly T[]> {
  const {
    initialOrderFactories,
    rotationBase,
    getItemKey,
    maximumOrderCount = Number.POSITIVE_INFINITY,
  } = params
  const seenOrderKeys = new Set<string>()
  let yieldedOrderCount = 0
  const getOrderKey = (order: readonly T[]): string =>
    order.map(getItemKey).join("\u0000")

  for (const createOrder of initialOrderFactories) {
    if (yieldedOrderCount >= maximumOrderCount) return
    const order = createOrder()
    const key = getOrderKey(order)
    if (seenOrderKeys.has(key)) continue
    seenOrderKeys.add(key)
    yieldedOrderCount++
    yield order
  }

  for (let offset = 1; offset < rotationBase.length; offset++) {
    if (yieldedOrderCount >= maximumOrderCount) return
    const order = [
      ...rotationBase.slice(offset),
      ...rotationBase.slice(0, offset),
    ]
    const key = getOrderKey(order)
    if (seenOrderKeys.has(key)) continue
    seenOrderKeys.add(key)
    yieldedOrderCount++
    yield order
  }
}

interface HeapEntry {
  node: number
  direction: number
  score: number
}

class MinHeap {
  private values: HeapEntry[] = []

  get size(): number {
    return this.values.length
  }

  push(value: HeapEntry): void {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.values[parent]!.score <= value.score) break
      this.values[index] = this.values[parent]!
      index = parent
    }
    this.values[index] = value
  }

  pop(): HeapEntry | undefined {
    const result = this.values[0]
    const last = this.values.pop()
    if (!result || !last || this.values.length === 0) return result
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      if (left >= this.values.length) break
      const child =
        right < this.values.length &&
        this.values[right]!.score < this.values[left]!.score
          ? right
          : left
      if (this.values[child]!.score >= last.score) break
      this.values[index] = this.values[child]!
      index = child
    }
    this.values[index] = last
    return result
  }
}

function getPerpendicularAxis(
  point: Point2D,
  direction: PreparedBus["direction"],
): number {
  return direction === "left" || direction === "right" ? point.y : point.x
}

function getConnectorVariants(start: Point2D, end: Point2D): Point2D[][] {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const absoluteX = Math.abs(deltaX)
  const absoluteY = Math.abs(deltaY)
  if (
    absoluteX < EPSILON ||
    absoluteY < EPSILON ||
    Math.abs(absoluteX - absoluteY) < EPSILON
  ) {
    return [[start, end]]
  }
  if (absoluteX > absoluteY) {
    return [
      [start, { x: start.x + Math.sign(deltaX) * absoluteY, y: end.y }, end],
      [start, { x: end.x - Math.sign(deltaX) * absoluteY, y: start.y }, end],
    ]
  }
  return [
    [start, { x: end.x, y: start.y + Math.sign(deltaY) * absoluteX }, end],
    [start, { x: start.x, y: end.y - Math.sign(deltaY) * absoluteX }, end],
  ]
}

function compressPath(points: Point2D[]): Point2D[] {
  if (points.length < 3) return points
  const compressed = [points[0]!]
  for (let index = 1; index < points.length - 1; index++) {
    const previous = compressed.at(-1)!
    const current = points[index]!
    const next = points[index + 1]!
    const incomingX = Math.sign(current.x - previous.x)
    const incomingY = Math.sign(current.y - previous.y)
    const outgoingX = Math.sign(next.x - current.x)
    const outgoingY = Math.sign(next.y - current.y)
    if (incomingX !== outgoingX || incomingY !== outgoingY) {
      compressed.push(current)
    }
  }
  compressed.push(points.at(-1)!)
  return compressed
}

function getSegments(
  points: readonly Point2D[],
  width: number,
  layer: string,
): RoutedSegment[] {
  return points.slice(1).flatMap((point, index) => {
    const start = points[index]!
    return distance(start, point) < EPSILON
      ? []
      : [{ start, end: point, width, layer }]
  })
}

function segmentIsStraightOr45Degrees(segment: RoutedSegment): boolean {
  const deltaX = Math.abs(segment.end.x - segment.start.x)
  const deltaY = Math.abs(segment.end.y - segment.start.y)
  return (
    deltaX < EPSILON || deltaY < EPSILON || Math.abs(deltaX - deltaY) < EPSILON
  )
}

function pathHasNoProperSelfCrossing(segments: RoutedSegment[]): boolean {
  for (let firstIndex = 0; firstIndex < segments.length; firstIndex++) {
    for (
      let secondIndex = firstIndex + 2;
      secondIndex < segments.length;
      secondIndex++
    ) {
      if (
        firstIndex === 0 &&
        secondIndex === segments.length - 1 &&
        distance(segments[firstIndex]!.start, segments[secondIndex]!.end) <
          EPSILON
      ) {
        continue
      }
      if (
        distanceSegmentToSegment(
          segments[firstIndex]!.start,
          segments[firstIndex]!.end,
          segments[secondIndex]!.start,
          segments[secondIndex]!.end,
        ) < EPSILON
      ) {
        return false
      }
    }
  }
  return true
}

function getPlanVias(plan: FanoutRoutePlan): RoutedVia[] {
  return [
    plan.via,
    ...(plan.additionalVias ?? []),
    plan.planeEndpointVia,
  ].filter((via): via is RoutedVia => Boolean(via))
}

function getBlockingCopper(params: {
  srj: SimpleRouteJson
  acceptedPlans: readonly FanoutRoutePlan[]
  allowBlindAndBuriedVias: boolean
}): { segments: BlockingSegment[]; vias: BlockingVia[] } {
  const { srj, acceptedPlans, allowBlindAndBuriedVias } = params
  const routedTraceCopper = getAllRoutedTraceCopper(
    srj,
    allowBlindAndBuriedVias,
  )
  return {
    segments: [
      ...routedTraceCopper.flatMap((copper) =>
        copper.segments.map((segment) => ({
          connectionName: copper.connectionName,
          segment,
        })),
      ),
      ...acceptedPlans.flatMap((plan) =>
        [...plan.segments, ...(plan.planeEndpointSegments ?? [])].map(
          (segment) => ({
            connectionName: plan.connectionName,
            segment,
          }),
        ),
      ),
    ],
    vias: [
      ...routedTraceCopper.flatMap((copper) =>
        copper.vias.map((via) => ({
          connectionName: copper.connectionName,
          via,
        })),
      ),
      ...acceptedPlans.flatMap((plan) =>
        getPlanVias(plan).map((via) => ({
          connectionName: plan.connectionName,
          via,
        })),
      ),
    ],
  }
}

function buildPlan(params: {
  bus: PreparedBus
  terminal: ViaMinimalWindingTerminal
  targetLayer: string
  targetLayerPoints: Point2D[]
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  allowBlindAndBuriedVias: boolean
}): FanoutRoutePlan {
  const {
    bus,
    terminal,
    targetLayer,
    targetLayerPoints,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    allowBlindAndBuriedVias,
  } = params
  const connection = terminal.connection
  const sourcePoint = {
    x: connection.sourcePoint.x,
    y: connection.sourcePoint.y,
  }
  const sourceSegment: RoutedSegment = {
    start: sourcePoint,
    end: terminal.viaPoint,
    width: traceWidth,
    layer: connection.sourceLayer,
  }
  const hasSourceDogbone = distance(sourcePoint, terminal.viaPoint) > EPSILON
  const targetSegments = getSegments(targetLayerPoints, traceWidth, targetLayer)
  const spanLayers = getViaSpanLayers({
    fromLayer: connection.sourceLayer,
    toLayer: targetLayer,
    layerNames,
    allowBlindAndBuriedVias,
  })
  const via: RoutedVia = {
    center: terminal.viaPoint,
    diameter: viaDiameter,
    holeDiameter: viaHoleDiameter,
    fromLayer: connection.sourceLayer,
    toLayer: targetLayer,
    spanLayers,
  }
  const route: SimplifiedPcbTrace["route"] = [
    {
      route_type: "wire",
      ...sourcePoint,
      width: traceWidth,
      layer: connection.sourceLayer,
      ...(connection.sourcePoint.pcb_port_id
        ? { start_pcb_port_id: connection.sourcePoint.pcb_port_id }
        : {}),
    },
    ...(hasSourceDogbone
      ? [
          {
            route_type: "wire" as const,
            ...terminal.viaPoint,
            width: traceWidth,
            layer: connection.sourceLayer,
          },
        ]
      : []),
    {
      route_type: "via",
      ...terminal.viaPoint,
      from_layer: connection.sourceLayer,
      to_layer: targetLayer,
      via_diameter: viaDiameter,
      via_hole_diameter: viaHoleDiameter,
    },
    {
      route_type: "wire",
      ...terminal.viaPoint,
      width: traceWidth,
      layer: targetLayer,
    },
    ...targetLayerPoints.slice(1).map((point) => ({
      route_type: "wire" as const,
      ...point,
      width: traceWidth,
      layer: targetLayer,
    })),
  ]
  const outputIds = createFanoutOutputIds({
    connectionName: connection.connection.name,
    sourcePointIndex: connection.sourcePointIndex,
  })
  const segments = [
    ...(hasSourceDogbone ? [sourceSegment] : []),
    ...targetSegments,
  ]
  const cornerBandSide = getCornerBandSide(bus.exitEdge, bus.preferredExit)
  return {
    busId: bus.busId,
    connectionName: connection.connection.name,
    connectionIndex: connection.connectionIndex,
    sourcePointIndex: connection.sourcePointIndex,
    sourcePoint: connection.sourcePoint,
    sourceObstacle: connection.sourceObstacle,
    sourceLayer: connection.sourceLayer,
    targetPoint: connection.targetPoint,
    targetLayer,
    termination: bus.termination,
    direction: bus.direction,
    ...(bus.exitEdge ? { exitEdge: bus.exitEdge } : {}),
    ...(cornerBandSide ? { cornerBandSide } : {}),
    exitPoint: terminal.exitPoint,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: outputIds.traceId,
      connection_name: connection.connection.name,
      connectsTo: [
        ...(connection.sourcePoint.pointId
          ? [connection.sourcePoint.pointId]
          : []),
        ...(connection.sourcePoint.pcb_port_id
          ? [connection.sourcePoint.pcb_port_id]
          : []),
        outputIds.boundaryExitPointId,
      ],
      route,
    },
    segments,
    via,
    length: segments.reduce(
      (total, segment) => total + distance(segment.start, segment.end),
      0,
    ),
  }
}

export function routeViaMinimalWindingAlternatives(
  params: RouteViaMinimalWindingParams,
  maximumAlternatives = 1,
): FanoutRoutePlan[][] {
  if (!Number.isInteger(maximumAlternatives) || maximumAlternatives < 1) {
    throw new Error(
      `FanoutSolver: maximum winding alternatives must be a positive integer, received ${maximumAlternatives}`,
    )
  }
  const {
    srj,
    bus,
    targetLayer,
    terminals,
    acceptedPlans,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
    maximumRouteOrderAttempts,
    reservedVias = [],
    softViaCapacityGroups = [],
    gridStepDivisor = 1,
    preferTargetDirectedLaneBias = false,
    expandedStateBudget,
    enableJointRouteSearch = false,
  } = params
  if (
    maximumRouteOrderAttempts !== undefined &&
    (!Number.isInteger(maximumRouteOrderAttempts) ||
      maximumRouteOrderAttempts < 1)
  ) {
    throw new Error(
      `FanoutSolver: maximumRouteOrderAttempts must be a positive integer, received ${maximumRouteOrderAttempts}`,
    )
  }

  if (gridStepDivisor !== 1 && gridStepDivisor !== 2) {
    throw new Error(
      `FanoutSolver: gridStepDivisor must be 1 or 2, received ${gridStepDivisor}`,
    )
  }
  if (
    terminals.length === 0 ||
    !bus.exitEdge ||
    terminals.some(
      (terminal) => terminal.connection.sourceLayer === targetLayer,
    )
  ) {
    return []
  }

  const gridStep = (traceWidth + clearance) / gridStepDivisor
  if (!Number.isFinite(gridStep) || gridStep <= 0) return []
  const { minX, maxX, minY, maxY } = bus.sharedBoundary
  const boundedSoftViaCapacityGroups = softViaCapacityGroups
    .map((group) => {
      const points = group.points.filter(
        (point) =>
          point.x >= minX - EPSILON &&
          point.x <= maxX + EPSILON &&
          point.y >= minY - EPSILON &&
          point.y <= maxY + EPSILON,
      )
      const requiredPointCount = Math.max(
        0,
        (group.minimumRemainingPointCount ?? 1) -
          (group.points.length - points.length),
      )
      return {
        ...group,
        points,
        minimumRemainingPointCount: requiredPointCount,
      }
    })
    .filter((group) => group.minimumRemainingPointCount > 0)
  const capacityGroupIsViable = (
    group: ViaMinimalWindingSoftViaCapacityGroup,
  ): boolean => group.points.length >= (group.minimumRemainingPointCount ?? 1)
  const softCapacityBasePenalty = Math.max(
    gridStep,
    (maxX - minX + (maxY - minY)) * 4,
  )
  const segmentBlocksSoftCapacityPoint = (
    segment: RoutedSegment,
    point: Point2D,
  ): boolean =>
    distancePointToSegment(point, segment.start, segment.end) <
    viaDiameter / 2 + segment.width / 2 + clearance - EPSILON
  const getLiveSoftCapacityGroups = (
    segments: readonly RoutedSegment[],
  ): ViaMinimalWindingSoftViaCapacityGroup[] =>
    boundedSoftViaCapacityGroups.map((group) => ({
      ...group,
      points: group.points.filter((point) =>
        segments.every(
          (segment) => !segmentBlocksSoftCapacityPoint(segment, point),
        ),
      ),
    }))
  const getSoftCapacityPenalty = (
    segments: readonly RoutedSegment[],
    liveGroups: readonly ViaMinimalWindingSoftViaCapacityGroup[],
  ): number =>
    liveGroups.reduce((total, group) => {
      const loss = group.points.filter((point) =>
        segments.some((segment) =>
          segmentBlocksSoftCapacityPoint(segment, point),
        ),
      ).length
      if (loss === 0) return total
      const remaining = group.points.length - loss
      const required = group.minimumRemainingPointCount ?? 1
      return (
        total +
        (remaining < required
          ? softCapacityBasePenalty * 64
          : (softCapacityBasePenalty * loss) / (remaining - required + 1) ** 2)
      )
    }, 0)
  const columnCount = Math.floor((maxX - minX) / gridStep) + 1
  const rowCount = Math.floor((maxY - minY) / gridStep) + 1
  const nodeCount = columnCount * rowCount
  if (columnCount < 2 || rowCount < 2 || nodeCount > MAX_GRID_NODE_COUNT) {
    return []
  }
  const nodes: GridNode[] = Array.from({ length: nodeCount }, (_, index) => {
    const column = index % columnCount
    const row = Math.floor(index / columnCount)
    return {
      column,
      row,
      point: { x: minX + column * gridStep, y: minY + row * gridStep },
    }
  })
  const targetLayerObstacles = srj.obstacles.filter((obstacle) =>
    obstacle.layers.includes(targetLayer),
  )
  const targetLayerObstacleIndex = new ObstacleSpatialIndex(
    targetLayerObstacles,
  )
  const blockingCopper = getBlockingCopper({
    srj,
    acceptedPlans,
    allowBlindAndBuriedVias,
  })
  const blockingSegments = blockingCopper.segments.filter(({ segment }) => {
    if (segment.layer !== targetLayer) return false
    const margin = (segment.width + traceWidth) / 2 + clearance
    return !(
      Math.max(segment.start.x, segment.end.x) < minX - margin ||
      Math.min(segment.start.x, segment.end.x) > maxX + margin ||
      Math.max(segment.start.y, segment.end.y) < minY - margin ||
      Math.min(segment.start.y, segment.end.y) > maxY + margin
    )
  })
  const blockingSegmentIndex = new BlockingSegmentSpatialIndex(blockingSegments)
  const blockingVias = blockingCopper.vias.filter(({ via }) => {
    if (!via.spanLayers.includes(targetLayer)) return false
    const margin = via.diameter / 2 + traceWidth / 2 + clearance
    return !(
      via.center.x < minX - margin ||
      via.center.x > maxX + margin ||
      via.center.y < minY - margin ||
      via.center.y > maxY + margin
    )
  })
  blockingVias.push(
    ...reservedVias.filter(({ via }) => {
      if (!via.spanLayers.includes(targetLayer)) return false
      const margin = via.diameter / 2 + traceWidth / 2 + clearance
      return !(
        via.center.x < minX - margin ||
        via.center.x > maxX + margin ||
        via.center.y < minY - margin ||
        via.center.y > maxY + margin
      )
    }),
  )
  const terminalVias: BlockingVia[] = terminals.map((terminal) => ({
    connectionName: terminal.connection.connection.name,
    via: {
      center: terminal.viaPoint,
      diameter: viaDiameter,
      spanLayers: getViaSpanLayers({
        fromLayer: terminal.connection.sourceLayer,
        toLayer: targetLayer,
        layerNames,
        allowBlindAndBuriedVias,
      }),
    },
  }))
  const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
  const sharesNet = (first: string, second: string): boolean =>
    first === second ||
    (allowSameNetMerges && connectionsShareElectricalNet(srj, first, second))
  const allBlockingVias = [...blockingVias, ...terminalVias]
  const maximumViaToTraceDistance = allBlockingVias.reduce(
    (maximum, { via }) =>
      Math.max(maximum, via.diameter / 2 + traceWidth / 2 + clearance),
    traceWidth / 2 + clearance,
  )
  const viasByX = allBlockingVias.toSorted(
    (first, second) => first.via.center.x - second.via.center.x,
  )
  const getFirstViaAtOrAfterX = (minimumX: number): number => {
    let low = 0
    let high = viasByX.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (viasByX[middle]!.via.center.x < minimumX) low = middle + 1
      else high = middle
    }
    return low
  }
  const segmentIsClear = (params: {
    segment: RoutedSegment
    terminal: ViaMinimalWindingTerminal
    acceptedAttemptSegments: BlockingSegment[]
    acceptedAttemptSegmentIndex?: BlockingSegmentSpatialIndex
    clearanceCache?: Map<string, boolean>
  }): boolean => {
    const {
      segment,
      terminal,
      acceptedAttemptSegments,
      acceptedAttemptSegmentIndex,
      clearanceCache,
    } = params
    const startKey = `${segment.start.x},${segment.start.y}`
    const endKey = `${segment.end.x},${segment.end.y}`
    const cacheKey =
      startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`
    const cached = clearanceCache?.get(cacheKey)
    if (cached !== undefined) return cached
    const finish = (isClear: boolean) => {
      clearanceCache?.set(cacheKey, isClear)
      return isClear
    }
    const connectionName = terminal.connection.connection.name
    const requiredObstacleClearance = segment.width / 2 + clearance
    for (const obstacle of targetLayerObstacleIndex.querySegment(
      segment,
      requiredObstacleClearance,
    )) {
      if (
        obstacle.connectedTo.includes(connectionName) ||
        (allowSameNetMerges &&
          obstacleSharesElectricalNet(srj, obstacle, connectionName))
      ) {
        continue
      }
      if (
        distanceSegmentToObstacle(segment, obstacle) <
        requiredObstacleClearance - EPSILON
      ) {
        return finish(false)
      }
    }
    for (const blocker of blockingSegmentIndex.querySegment(
      segment,
      clearance,
    )) {
      if (sharesNet(connectionName, blocker.connectionName)) continue
      if (
        distanceSegmentToSegment(
          segment.start,
          segment.end,
          blocker.segment.start,
          blocker.segment.end,
        ) <
        (segment.width + blocker.segment.width) / 2 + clearance - EPSILON
      ) {
        return finish(false)
      }
    }
    const acceptedBlockers = acceptedAttemptSegmentIndex
      ? acceptedAttemptSegmentIndex.querySegment(segment, clearance)
      : acceptedAttemptSegments
    for (const blocker of acceptedBlockers) {
      if (sharesNet(connectionName, blocker.connectionName)) continue
      if (
        distanceSegmentToSegment(
          segment.start,
          segment.end,
          blocker.segment.start,
          blocker.segment.end,
        ) <
        (segment.width + blocker.segment.width) / 2 + clearance - EPSILON
      ) {
        return finish(false)
      }
    }
    const segmentMinX = Math.min(segment.start.x, segment.end.x)
    const segmentMaxX = Math.max(segment.start.x, segment.end.x)
    const segmentMinY = Math.min(segment.start.y, segment.end.y)
    const segmentMaxY = Math.max(segment.start.y, segment.end.y)
    for (
      let viaIndex = getFirstViaAtOrAfterX(
        segmentMinX - maximumViaToTraceDistance,
      );
      viaIndex < viasByX.length;
      viaIndex++
    ) {
      const blocker = viasByX[viaIndex]!
      if (blocker.via.center.x > segmentMaxX + maximumViaToTraceDistance) {
        break
      }
      if (sharesNet(connectionName, blocker.connectionName)) continue
      const requiredDistance =
        blocker.via.diameter / 2 + segment.width / 2 + clearance
      if (
        blocker.via.center.x < segmentMinX - requiredDistance ||
        blocker.via.center.x > segmentMaxX + requiredDistance ||
        blocker.via.center.y < segmentMinY - requiredDistance ||
        blocker.via.center.y > segmentMaxY + requiredDistance
      ) {
        continue
      }
      if (
        distancePointToSegment(blocker.via.center, segment.start, segment.end) <
        requiredDistance - EPSILON
      ) {
        return finish(false)
      }
    }
    return finish(true)
  }

  const connectorCandidates = (params: {
    terminal: ViaMinimalWindingTerminal
    endpoint: Point2D
    acceptedAttemptSegments: BlockingSegment[]
    acceptedAttemptSegmentIndex: BlockingSegmentSpatialIndex
    clearanceCache: Map<string, boolean>
    liveCapacityGroups: readonly ViaMinimalWindingSoftViaCapacityGroup[]
  }): ConnectorCandidate[] => {
    const {
      terminal,
      endpoint,
      acceptedAttemptSegments,
      acceptedAttemptSegmentIndex,
      clearanceCache,
      liveCapacityGroups,
    } = params
    const candidates: ConnectorCandidate[] = []
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      const node = nodes[nodeIndex]!
      const connectorDistance = distance(endpoint, node.point)
      if (connectorDistance > gridStep * CONNECTOR_RADIUS_IN_STEPS) continue
      for (const points of getConnectorVariants(endpoint, node.point)) {
        const segments = getSegments(points, traceWidth, targetLayer)
        if (
          !segments.every((segment) =>
            segmentIsClear({
              segment,
              terminal,
              acceptedAttemptSegments,
              acceptedAttemptSegmentIndex,
              clearanceCache,
            }),
          )
        ) {
          continue
        }
        candidates.push({
          nodeIndex,
          points,
          radialDistance: connectorDistance,
          length:
            segments.reduce(
              (total, segment) => total + distance(segment.start, segment.end),
              0,
            ) + getSoftCapacityPenalty(segments, liveCapacityGroups),
        })
      }
    }
    return candidates
      .toSorted(
        (first, second) =>
          (liveCapacityGroups.length > 0
            ? first.length - second.length ||
              first.radialDistance - second.radialDistance
            : first.radialDistance - second.radialDistance ||
              first.length - second.length) ||
          first.nodeIndex - second.nodeIndex,
      )
      .slice(0, MAX_CONNECTOR_COUNT)
  }

  const routeOneBest = (params: {
    terminal: ViaMinimalWindingTerminal
    acceptedAttemptSegments: BlockingSegment[]
    laneBias: -1 | 0 | 1
    diversitySegments?: readonly RoutedSegment[]
    maximumExpandedStateCount?: number
  }): WindingPathCandidate | null => {
    const {
      terminal,
      acceptedAttemptSegments,
      laneBias,
      diversitySegments = [],
      maximumExpandedStateCount = MAX_EXPANDED_STATE_COUNT,
    } = params
    const liveCapacityGroups = getLiveSoftCapacityGroups(
      acceptedAttemptSegments.map(({ segment }) => segment),
    )
    if (liveCapacityGroups.some((group) => !capacityGroupIsViable(group))) {
      return null
    }
    const acceptedAttemptSegmentIndex = new BlockingSegmentSpatialIndex(
      acceptedAttemptSegments,
    )
    const clearanceCache = new Map<string, boolean>()
    const starts = connectorCandidates({
      terminal,
      endpoint: terminal.viaPoint,
      acceptedAttemptSegments,
      acceptedAttemptSegmentIndex,
      clearanceCache,
      liveCapacityGroups,
    })
    const ends = connectorCandidates({
      terminal,
      endpoint: terminal.exitPoint,
      acceptedAttemptSegments,
      acceptedAttemptSegmentIndex,
      clearanceCache,
      liveCapacityGroups,
    })
    if (starts.length === 0 || ends.length === 0) return null
    const endByNode = new Map<number, ConnectorCandidate[]>()
    for (const end of ends) {
      const values = endByNode.get(end.nodeIndex) ?? []
      values.push(end)
      endByNode.set(end.nodeIndex, values)
    }
    const stateCount = nodeCount * 9
    const distances = new Float64Array(stateCount).fill(
      Number.POSITIVE_INFINITY,
    )
    const previous = new Int32Array(stateCount).fill(-1)
    const heap = new MinHeap()
    const heuristic = (point: Point2D): number => {
      const deltaX = Math.abs(point.x - terminal.exitPoint.x)
      const deltaY = Math.abs(point.y - terminal.exitPoint.y)
      return (
        Math.max(deltaX, deltaY) + (Math.SQRT2 - 1) * Math.min(deltaX, deltaY)
      )
    }
    for (const start of starts) {
      const state = start.nodeIndex * 9 + 8
      if (start.length >= distances[state]!) continue
      distances[state] = start.length
      const remaining = heuristic(nodes[start.nodeIndex]!.point)
      heap.push({
        node: start.nodeIndex,
        direction: 8,
        score: start.length + remaining,
      })
    }
    const directions = [
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
    ] as const
    const startsByNode = new Map<number, ConnectorCandidate[]>()
    for (const start of starts) {
      const values = startsByNode.get(start.nodeIndex) ?? []
      values.push(start)
      startsByNode.set(start.nodeIndex, values)
    }
    let bestGoalCost = Number.POSITIVE_INFINITY
    let bestGoalPoints: Point2D[] | null = null
    let expandedStateCount = 0
    while (
      heap.size > 0 &&
      expandedStateCount < maximumExpandedStateCount &&
      (expandedStateBudget?.remaining ?? 1) > 0
    ) {
      const current = heap.pop()!
      if (current.score >= bestGoalCost - EPSILON) break
      const state = current.node * 9 + current.direction
      const currentDistance = distances[state]!
      if (
        current.score >
        currentDistance + heuristic(nodes[current.node]!.point) + EPSILON
      )
        continue
      expandedStateCount++
      if (expandedStateBudget) {
        expandedStateBudget.remaining--
        if (expandedStateBudget.remaining <= 0) {
          expandedStateBudget.exhausted = true
        }
      }
      const endConnectors = endByNode.get(current.node)
      if (endConnectors) {
        const gridPoints: Point2D[] = []
        let pathState = state
        while (pathState >= 0) {
          gridPoints.push(nodes[Math.floor(pathState / 9)]!.point)
          pathState = previous[pathState]!
        }
        gridPoints.reverse()
        let firstState = state
        while (previous[firstState]! >= 0) {
          firstState = previous[firstState]!
        }
        const startNodeIndex = Math.floor(firstState / 9)
        const startConnectors = startsByNode.get(startNodeIndex) ?? []
        const shortestStartLength = Math.min(
          ...startConnectors.map((candidate) => candidate.length),
        )
        for (const startConnector of startConnectors) {
          for (const endConnector of endConnectors) {
            const candidateCost =
              currentDistance -
              shortestStartLength +
              startConnector.length +
              endConnector.length
            if (candidateCost >= bestGoalCost - EPSILON) continue
            const points = compressPath([
              ...startConnector.points,
              ...gridPoints.slice(1),
              ...endConnector.points.toReversed().slice(1),
            ])
            const segments = getSegments(points, traceWidth, targetLayer)
            if (
              !segments.every(segmentIsStraightOr45Degrees) ||
              !pathHasNoProperSelfCrossing(segments) ||
              !segments.every((segment) =>
                segmentIsClear({
                  segment,
                  terminal,
                  acceptedAttemptSegments,
                  acceptedAttemptSegmentIndex,
                  clearanceCache,
                }),
              )
            ) {
              continue
            }
            bestGoalCost = candidateCost
            bestGoalPoints = points
          }
        }
      }
      const node = nodes[current.node]!
      for (
        let directionIndex = 0;
        directionIndex < directions.length;
        directionIndex++
      ) {
        if (current.direction !== 8) {
          const rawDirectionDelta = Math.abs(current.direction - directionIndex)
          if (Math.min(rawDirectionDelta, 8 - rawDirectionDelta) > 1) {
            continue
          }
        }
        const [deltaColumn, deltaRow] = directions[directionIndex]!
        const column = node.column + deltaColumn
        const row = node.row + deltaRow
        if (column < 0 || column >= columnCount || row < 0 || row >= rowCount) {
          continue
        }
        const nextNode = row * columnCount + column
        const nextPoint = nodes[nextNode]!.point
        const segment: RoutedSegment = {
          start: node.point,
          end: nextPoint,
          width: traceWidth,
          layer: targetLayer,
        }
        if (
          !segmentIsClear({
            segment,
            terminal,
            acceptedAttemptSegments,
            acceptedAttemptSegmentIndex,
            clearanceCache,
          })
        ) {
          continue
        }
        const addsTurn =
          current.direction !== 8 && current.direction !== directionIndex
        const nextTrack = getPerpendicularAxis(nextPoint, boundaryDirection)
        const targetTrack = getPerpendicularAxis(
          terminal.exitPoint,
          boundaryDirection,
        )
        const lanePenalty =
          laneBias === 0
            ? 0
            : laneBias > 0
              ? Math.max(0, targetTrack - nextTrack) * 0.2
              : Math.max(0, nextTrack - targetTrack) * 0.2
        const nextDistance =
          currentDistance +
          (deltaColumn !== 0 && deltaRow !== 0
            ? gridStep * Math.SQRT2
            : gridStep) +
          (addsTurn ? gridStep * 0.2 : 0) +
          lanePenalty +
          diversitySegments.reduce(
            (penalty, diversitySegment) =>
              distanceSegmentToSegment(
                segment.start,
                segment.end,
                diversitySegment.start,
                diversitySegment.end,
              ) <
              gridStep * 0.25 - EPSILON
                ? penalty + gridStep * 0.75
                : penalty,
            0,
          ) +
          getSoftCapacityPenalty([segment], liveCapacityGroups)
        const nextState = nextNode * 9 + directionIndex
        if (nextDistance >= distances[nextState]! - EPSILON) continue
        distances[nextState] = nextDistance
        previous[nextState] = state
        const remaining = heuristic(nextPoint)
        heap.push({
          node: nextNode,
          direction: directionIndex,
          score: nextDistance + remaining,
        })
      }
    }
    if (!bestGoalPoints) return null
    return {
      points: bestGoalPoints,
      physicalLength: getSegments(
        bestGoalPoints,
        traceWidth,
        targetLayer,
      ).reduce(
        (total, segment) => total + distance(segment.start, segment.end),
        0,
      ),
    }
  }

  const routeOneAlternatives = (params: {
    terminal: ViaMinimalWindingTerminal
    acceptedAttemptSegments: BlockingSegment[]
    laneBias: -1 | 0 | 1
    maximumAlternatives: number
    maximumExpandedStateCount?: number
  }): WindingPathCandidate[] => {
    const alternatives: WindingPathCandidate[] = []
    const seenKeys = new Set<string>()
    const diversitySegments: RoutedSegment[] = []
    for (
      let attempt = 0;
      attempt < MAX_DIVERSIFIED_PATH_ATTEMPTS &&
      alternatives.length < params.maximumAlternatives;
      attempt++
    ) {
      const candidate = routeOneBest({
        terminal: params.terminal,
        acceptedAttemptSegments: params.acceptedAttemptSegments,
        laneBias: params.laneBias,
        diversitySegments,
        maximumExpandedStateCount: params.maximumExpandedStateCount,
      })
      if (!candidate) break
      const candidateKey = candidate.points
        .map((point) => `${point.x},${point.y}`)
        .join(";")
      if (!seenKeys.has(candidateKey)) {
        seenKeys.add(candidateKey)
        alternatives.push(candidate)
      }
      diversitySegments.push(
        ...getSegments(candidate.points, traceWidth, targetLayer),
      )
    }
    return alternatives
  }

  const targetOrderedTerminals = terminals.toSorted((first, second) => {
    const axisDifference =
      getPerpendicularAxis(first.exitPoint, boundaryDirection) -
      getPerpendicularAxis(second.exitPoint, boundaryDirection)
    return (
      axisDifference ||
      first.connection.connection.name.localeCompare(
        second.connection.connection.name,
      )
    )
  })
  const viaTracks = terminals.map((terminal) =>
    getPerpendicularAxis(terminal.viaPoint, boundaryDirection),
  )
  const targetTracks = targetOrderedTerminals.map((terminal) =>
    getPerpendicularAxis(terminal.exitPoint, boundaryDirection),
  )
  const meanViaTrack =
    viaTracks.reduce((sum, track) => sum + track, 0) / viaTracks.length
  const meanTargetTrack =
    targetTracks.reduce((sum, track) => sum + track, 0) / targetTracks.length
  const viasAreBeforeTargets =
    Math.max(...viaTracks) < Math.min(...targetTracks) - EPSILON
  const viasAreAfterTargets =
    Math.min(...viaTracks) > Math.max(...targetTracks) + EPSILON
  const laneBiases = preferTargetDirectedLaneBias
    ? viasAreBeforeTargets
      ? ([0, 1, -1] as const)
      : viasAreAfterTargets
        ? ([0, -1, 1] as const)
        : bus.direction === boundaryDirection &&
            meanTargetTrack > meanViaTrack + EPSILON
          ? ([1, 0, -1] as const)
          : bus.direction === boundaryDirection &&
              meanTargetTrack < meanViaTrack - EPSILON
            ? ([-1, 0, 1] as const)
            : ([0, 1, -1] as const)
    : viasAreBeforeTargets
      ? ([1, 0, -1] as const)
      : viasAreAfterTargets
        ? ([-1, 0, 1] as const)
        : ([0, 1, -1] as const)
  const initialRouteOrderFactories: Array<
    () => readonly ViaMinimalWindingTerminal[]
  > = []
  if (viasAreBeforeTargets) {
    initialRouteOrderFactories.push(() => [
      ...targetOrderedTerminals.slice(1),
      targetOrderedTerminals[0]!,
    ])
  } else if (viasAreAfterTargets) {
    initialRouteOrderFactories.push(() => [...targetOrderedTerminals].reverse())
  }
  initialRouteOrderFactories.push(
    ...(preferTargetDirectedLaneBias &&
    bus.direction === boundaryDirection &&
    meanTargetTrack < meanViaTrack - EPSILON &&
    !viasAreBeforeTargets &&
    !viasAreAfterTargets
      ? [
          () => [...targetOrderedTerminals].reverse(),
          () => targetOrderedTerminals,
        ]
      : [
          () => targetOrderedTerminals,
          () => [...targetOrderedTerminals].reverse(),
        ]),
    () =>
      terminals.toSorted(
        (first, second) =>
          first.viaPoint.x - second.viaPoint.x ||
          first.viaPoint.y - second.viaPoint.y,
      ),
    () =>
      terminals.toSorted(
        (first, second) =>
          second.viaPoint.x - first.viaPoint.x ||
          second.viaPoint.y - first.viaPoint.y,
      ),
    () =>
      terminals.toSorted(
        (first, second) =>
          first.viaPoint.y - second.viaPoint.y ||
          first.viaPoint.x - second.viaPoint.x,
      ),
    () =>
      terminals.toSorted(
        (first, second) =>
          second.viaPoint.y - first.viaPoint.y ||
          second.viaPoint.x - first.viaPoint.x,
      ),
  )
  const maximumRouteOrderCount =
    maximumRouteOrderAttempts === undefined
      ? undefined
      : Math.ceil(maximumRouteOrderAttempts / laneBiases.length)
  const routeOrders = iterateUniqueRouteOrders({
    initialOrderFactories: initialRouteOrderFactories,
    rotationBase: targetOrderedTerminals,
    getItemKey: (terminal) => terminal.connection.connection.name,
    maximumOrderCount: maximumRouteOrderCount,
  })

  const alternatives: FanoutRoutePlan[][] = []
  const seenAlternativeKeys = new Set<string>()
  type JointRouteState = {
    acceptedAttemptSegments: BlockingSegment[]
    routedPointsByConnectionName: Map<string, Point2D[]>
    physicalLength: number
  }
  const routeStateKey = (state: JointRouteState): string =>
    [...state.routedPointsByConnectionName]
      .toSorted(([first], [second]) => first.localeCompare(second))
      .map(
        ([connectionName, points]) =>
          `${connectionName}:${points
            .map((point) => `${point.x},${point.y}`)
            .join(";")}`,
      )
      .join("|")
  const extendRouteState = (
    state: JointRouteState,
    terminal: ViaMinimalWindingTerminal,
    candidate: WindingPathCandidate,
  ): JointRouteState | null => {
    const connectionName = terminal.connection.connection.name
    const routedSegments = getSegments(
      candidate.points,
      traceWidth,
      targetLayer,
    )
    const remainingCapacityGroups = getLiveSoftCapacityGroups([
      ...state.acceptedAttemptSegments.map(({ segment }) => segment),
      ...routedSegments,
    ])
    if (
      remainingCapacityGroups.some((group) => !capacityGroupIsViable(group))
    ) {
      return null
    }
    return {
      acceptedAttemptSegments: [
        ...state.acceptedAttemptSegments,
        ...routedSegments.map((segment) => ({ connectionName, segment })),
      ],
      routedPointsByConnectionName: new Map([
        ...state.routedPointsByConnectionName,
        [connectionName, candidate.points] as const,
      ]),
      physicalLength: state.physicalLength + candidate.physicalLength,
    }
  }
  const routeGreedyAttempt = (
    routeOrder: readonly ViaMinimalWindingTerminal[],
    laneBias: -1 | 0 | 1,
  ): JointRouteState => {
    let state: JointRouteState = {
      acceptedAttemptSegments: [],
      routedPointsByConnectionName: new Map(),
      physicalLength: 0,
    }
    for (const terminal of routeOrder) {
      const candidate = routeOneBest({
        terminal,
        acceptedAttemptSegments: state.acceptedAttemptSegments,
        laneBias,
      })
      if (!candidate) return state
      const extended = extendRouteState(state, terminal, candidate)
      if (!extended) return state
      state = extended
    }
    return state
  }
  const routeJointBeamAttempt = (
    routeOrder: readonly ViaMinimalWindingTerminal[],
    laneBias: -1 | 0 | 1,
    seedState: JointRouteState,
  ): JointRouteState[] => {
    let frontier: JointRouteState[] = [seedState]
    const beamWidth = Math.max(
      DEFAULT_JOINT_ROUTE_BEAM_WIDTH * 2,
      Math.min(16, maximumAlternatives * 3),
    )
    const futureRouteScoreCache = new Map<string, number>()
    const getFutureRouteScore = (state: JointRouteState): number => {
      const stateKey = routeStateKey(state)
      const cached = futureRouteScoreCache.get(stateKey)
      if (cached !== undefined) return cached
      const acceptedAttemptSegmentIndex = new BlockingSegmentSpatialIndex(
        state.acceptedAttemptSegments,
      )
      let fullyClearRouteCount = 0
      let bestClearSegmentFractionTotal = 0
      for (const terminal of routeOrder) {
        if (
          state.routedPointsByConnectionName.has(
            terminal.connection.connection.name,
          )
        ) {
          continue
        }
        let bestClearSegmentFraction = 0
        for (const points of getConnectorVariants(
          terminal.viaPoint,
          terminal.exitPoint,
        )) {
          const segments = getSegments(points, traceWidth, targetLayer)
          if (segments.length === 0) continue
          const clearanceCache = new Map<string, boolean>()
          const clearSegmentCount = segments.filter((segment) =>
            segmentIsClear({
              segment,
              terminal,
              acceptedAttemptSegments: state.acceptedAttemptSegments,
              acceptedAttemptSegmentIndex,
              clearanceCache,
            }),
          ).length
          const clearSegmentFraction = clearSegmentCount / segments.length
          bestClearSegmentFraction = Math.max(
            bestClearSegmentFraction,
            clearSegmentFraction,
          )
        }
        if (bestClearSegmentFraction >= 1 - EPSILON) fullyClearRouteCount++
        bestClearSegmentFractionTotal += bestClearSegmentFraction
      }
      const score = fullyClearRouteCount * 100 + bestClearSegmentFractionTotal
      futureRouteScoreCache.set(stateKey, score)
      return score
    }
    for (
      let depth = seedState.routedPointsByConnectionName.size;
      depth < routeOrder.length;
      depth++
    ) {
      const nextByKey = new Map<string, { state: JointRouteState }>()
      for (const state of frontier) {
        for (const terminal of routeOrder) {
          const connectionName = terminal.connection.connection.name
          if (state.routedPointsByConnectionName.has(connectionName)) continue
          const candidates = routeOneAlternatives({
            terminal,
            acceptedAttemptSegments: state.acceptedAttemptSegments,
            laneBias,
            maximumAlternatives: 2,
            maximumExpandedStateCount: 60_000,
          })
          for (const candidate of candidates) {
            const extended = extendRouteState(state, terminal, candidate)
            if (!extended) continue
            const key = routeStateKey(extended)
            const existing = nextByKey.get(key)
            if (
              !existing ||
              extended.physicalLength < existing.state.physicalLength
            ) {
              nextByKey.set(key, { state: extended })
            }
          }
        }
      }
      const ordered = [...nextByKey.values()].toSorted(
        (first, second) =>
          getFutureRouteScore(second.state) -
            getFutureRouteScore(first.state) ||
          first.state.physicalLength - second.state.physicalLength ||
          routeStateKey(first.state).localeCompare(routeStateKey(second.state)),
      )
      const selected: typeof ordered = []
      const selectedKeys = new Set<string>()
      const connectionSet = (candidate: (typeof ordered)[number]) =>
        new Set(candidate.state.routedPointsByConnectionName.keys())
      const connectionSetDistance = (
        first: ReadonlySet<string>,
        second: ReadonlySet<string>,
      ): number =>
        [...first].filter((value) => !second.has(value)).length +
        [...second].filter((value) => !first.has(value)).length
      const uniqueSetCandidates = new Map<string, (typeof ordered)[number]>()
      for (const candidate of ordered) {
        const connectionSetKey = [...connectionSet(candidate)]
          .toSorted()
          .join("\u0000")
        if (!uniqueSetCandidates.has(connectionSetKey)) {
          uniqueSetCandidates.set(connectionSetKey, candidate)
        }
      }
      const remainingSetCandidates = [...uniqueSetCandidates.values()]
      const diverseSetLimit = Math.min(
        Math.ceil(beamWidth * 0.75),
        remainingSetCandidates.length,
      )
      while (selected.length < diverseSetLimit) {
        let bestIndex = 0
        let bestDistance = -1
        for (const [
          candidateIndex,
          candidate,
        ] of remainingSetCandidates.entries()) {
          const candidateSet = connectionSet(candidate)
          const minimumDistance =
            selected.length === 0
              ? Number.POSITIVE_INFINITY
              : Math.min(
                  ...selected.map((selectedCandidate) =>
                    connectionSetDistance(
                      candidateSet,
                      connectionSet(selectedCandidate),
                    ),
                  ),
                )
          if (minimumDistance > bestDistance) {
            bestDistance = minimumDistance
            bestIndex = candidateIndex
          }
        }
        const [candidate] = remainingSetCandidates.splice(bestIndex, 1)
        if (!candidate) break
        selected.push(candidate)
        selectedKeys.add(routeStateKey(candidate.state))
      }
      for (const candidate of ordered) {
        if (selected.length >= beamWidth) break
        const key = routeStateKey(candidate.state)
        if (selectedKeys.has(key)) continue
        selected.push(candidate)
        selectedKeys.add(key)
      }
      frontier = selected
        .map((candidate) => candidate.state)
        .toSorted(
          (first, second) =>
            getFutureRouteScore(second) - getFutureRouteScore(first) ||
            first.physicalLength - second.physicalLength ||
            routeStateKey(first).localeCompare(routeStateKey(second)),
        )
      if (frontier.length === 0) return []
    }
    return frontier
  }
  const backtrackGreedyState = (
    state: JointRouteState,
    routeOrder: readonly ViaMinimalWindingTerminal[],
    count: number,
  ): JointRouteState => {
    const routedTerminalCount = state.routedPointsByConnectionName.size
    const retainedTerminalCount = Math.max(0, routedTerminalCount - count)
    const retainedConnectionNames = new Set(
      routeOrder
        .slice(0, retainedTerminalCount)
        .map((terminal) => terminal.connection.connection.name),
    )
    const acceptedAttemptSegments = state.acceptedAttemptSegments.filter(
      ({ connectionName }) => retainedConnectionNames.has(connectionName),
    )
    return {
      acceptedAttemptSegments,
      routedPointsByConnectionName: new Map(
        [...state.routedPointsByConnectionName].filter(([connectionName]) =>
          retainedConnectionNames.has(connectionName),
        ),
      ),
      physicalLength: acceptedAttemptSegments.reduce(
        (total, { segment }) => total + distance(segment.start, segment.end),
        0,
      ),
    }
  }
  const buildPlansForState = (state: JointRouteState): FanoutRoutePlan[] =>
    terminals.map((terminal) => {
      const targetLayerPoints = state.routedPointsByConnectionName.get(
        terminal.connection.connection.name,
      )
      if (!targetLayerPoints) {
        throw new Error(
          `FanoutSolver: via-minimal winding route omitted "${terminal.connection.connection.name}"`,
        )
      }
      return buildPlan({
        bus,
        terminal,
        targetLayer,
        targetLayerPoints,
        layerNames,
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
        allowBlindAndBuriedVias,
      })
    })
  const addAlternative = (state: JointRouteState): boolean => {
    const plans = buildPlansForState(state)
    const alternativeKey = plans
      .map((plan) =>
        plan.segments
          .map(
            (segment) =>
              `${segment.start.x},${segment.start.y},${segment.end.x},${segment.end.y},${segment.layer}`,
          )
          .join(";"),
      )
      .join("|")
    if (seenAlternativeKeys.has(alternativeKey)) return false
    seenAlternativeKeys.add(alternativeKey)
    alternatives.push(plans)
    return true
  }
  let routeOrderAttemptCount = 0
  for (const routeOrder of routeOrders) {
    for (const laneBias of laneBiases) {
      if (
        maximumRouteOrderAttempts !== undefined &&
        routeOrderAttemptCount >= maximumRouteOrderAttempts
      ) {
        return alternatives
      }
      routeOrderAttemptCount++
      const greedyState = routeGreedyAttempt(routeOrder, laneBias)
      if (greedyState.routedPointsByConnectionName.size === routeOrder.length) {
        addAlternative(greedyState)
      } else if (
        routeOrder.length >= 4 &&
        enableJointRouteSearch &&
        expandedStateBudget !== undefined &&
        expandedStateBudget.remaining > 0 &&
        greedyState.routedPointsByConnectionName.size >= 2
      ) {
        const jointSeedState = backtrackGreedyState(
          greedyState,
          routeOrder,
          Math.min(2, greedyState.routedPointsByConnectionName.size),
        )
        for (const jointState of routeJointBeamAttempt(
          routeOrder,
          laneBias,
          jointSeedState,
        )) {
          addAlternative(jointState)
          if (alternatives.length >= maximumAlternatives) return alternatives
        }
      }
      if (alternatives.length >= maximumAlternatives) return alternatives
    }
  }
  return alternatives
}

export function routeViaMinimalWinding(
  params: RouteViaMinimalWindingParams,
): FanoutRoutePlan[] | null {
  return routeViaMinimalWindingAlternatives(params, 1)[0] ?? null
}
