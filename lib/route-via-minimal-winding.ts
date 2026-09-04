import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import type { GraphicsObject } from "graphics-debug"
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
const EXPANDED_STATES_PER_STEP = 5_000
const MAX_CONNECTOR_COUNT = 24
const CONNECTOR_RADIUS_IN_STEPS = 3.25

export interface ViaMinimalWindingTerminal {
  connection: PreparedConnection
  viaPoint: Point2D
  exitPoint: Point2D
}

export interface ViaMinimalWindingReservedVia {
  connectionName: string
  via: Pick<RoutedVia, "center" | "diameter" | "spanLayers">
  /** Keep the future pad-to-via dogbone available during source-layer escape. */
  sourceEscapeSegment?: RoutedSegment
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
  /** Use a finer uniform grid for narrow channels between reserved vias. */
  gridStepDivisor?: 1 | 2
  /** Bias bounded fixed-site searches toward the remote target band. */
  preferTargetDirectedLaneBias?: boolean
  /** Internal path-only mode used before a boundary-side via is appended. */
  allowSourceLayerRouting?: boolean
  /** Promote a blocked terminal while staying within maximumRouteOrderAttempts. */
  adaptiveRouteOrder?: boolean
  /** Align a fine grid with pad/interstice centers instead of the boundary. */
  alignGridToPads?: boolean
  /** Defer the outermost reversed target while routing the inner terminals. */
  includeReverseTargetRotation?: boolean
}

export interface RouteViaMinimalWindingProgress {
  phase: "route-connection"
  routeOrderAttempt: number
  connectionIndex: number
  connectionCount: number
  connectionName: string
  searchBatch: number
  expandedStateCount: number
  connectionComplete: boolean
  visualization?: GraphicsObject
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

interface BlockingSegment {
  connectionName: string
  segment: RoutedSegment
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

  sampleEntries(maximumCount: number): readonly HeapEntry[] {
    if (this.values.length <= maximumCount) return this.values
    const stride = Math.ceil(this.values.length / maximumCount)
    return this.values.filter((_, index) => index % stride === 0)
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
  const changesLayer = connection.sourceLayer !== targetLayer
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
    ...(changesLayer
      ? [
          {
            route_type: "via" as const,
            ...terminal.viaPoint,
            from_layer: connection.sourceLayer,
            to_layer: targetLayer,
            via_diameter: viaDiameter,
            via_hole_diameter: viaHoleDiameter,
          },
          {
            route_type: "wire" as const,
            ...terminal.viaPoint,
            width: traceWidth,
            layer: targetLayer,
          },
        ]
      : []),
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
    via: changesLayer ? via : undefined,
    length: segments.reduce(
      (total, segment) => total + distance(segment.start, segment.end),
      0,
    ),
  }
}

export function* routeViaMinimalWindingAlternativesSteps(
  params: RouteViaMinimalWindingParams,
  maximumAlternatives = 1,
  includeVisualization = false,
): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan[][], void> {
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
    gridStepDivisor = 1,
    preferTargetDirectedLaneBias = false,
    allowSourceLayerRouting = false,
    adaptiveRouteOrder = false,
    alignGridToPads = false,
    includeReverseTargetRotation = false,
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
    (!allowSourceLayerRouting &&
      terminals.some(
        (terminal) => terminal.connection.sourceLayer === targetLayer,
      ))
  ) {
    return []
  }

  const baseGridStep = (traceWidth + clearance) / gridStepDivisor
  const pitch = Math.min(bus.pitchX, bus.pitchY)
  const alignGridToPitch =
    alignGridToPads && gridStepDivisor === 2 && Number.isFinite(pitch)
  const gridStep = alignGridToPitch
    ? pitch / (2 * Math.ceil(pitch / (2 * baseGridStep)))
    : baseGridStep
  if (!Number.isFinite(gridStep) || gridStep <= 0) return []
  const { minX, maxX, minY, maxY } = bus.sharedBoundary
  const originX = bus.xCoordinates[0] ?? minX
  const originY = bus.yCoordinates[0] ?? minY
  const gridMinX = alignGridToPitch
    ? originX + Math.ceil((minX - originX) / gridStep) * gridStep
    : minX
  const gridMinY = alignGridToPitch
    ? originY + Math.ceil((minY - originY) / gridStep) * gridStep
    : minY
  const columnCount = Math.floor((maxX - gridMinX) / gridStep) + 1
  const rowCount = Math.floor((maxY - gridMinY) / gridStep) + 1
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
      point: { x: gridMinX + column * gridStep, y: gridMinY + row * gridStep },
    }
  })
  const sampledGridPoints = includeVisualization
    ? nodes
        .filter(
          (_, index) =>
            index % Math.max(1, Math.ceil(nodes.length / 1_000)) === 0,
        )
        .map((node) => node.point)
    : []
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
  if (allowSourceLayerRouting) {
    blockingSegments.push(
      ...reservedVias.flatMap((reserved) =>
        reserved.sourceEscapeSegment?.layer === targetLayer
          ? [
              {
                connectionName: reserved.connectionName,
                segment: reserved.sourceEscapeSegment,
              },
            ]
          : [],
      ),
    )
  }
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
  }): boolean => {
    const { segment, terminal, acceptedAttemptSegments } = params
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
        return false
      }
    }
    for (const blocker of blockingSegments) {
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
        return false
      }
    }
    for (const blocker of acceptedAttemptSegments) {
      if (sharesNet(connectionName, blocker.connectionName)) continue
      const margin = (segment.width + blocker.segment.width) / 2 + clearance
      if (
        Math.max(segment.start.x, segment.end.x) + margin <
          Math.min(blocker.segment.start.x, blocker.segment.end.x) ||
        Math.min(segment.start.x, segment.end.x) - margin >
          Math.max(blocker.segment.start.x, blocker.segment.end.x) ||
        Math.max(segment.start.y, segment.end.y) + margin <
          Math.min(blocker.segment.start.y, blocker.segment.end.y) ||
        Math.min(segment.start.y, segment.end.y) - margin >
          Math.max(blocker.segment.start.y, blocker.segment.end.y)
      )
        continue
      if (
        distanceSegmentToSegment(
          segment.start,
          segment.end,
          blocker.segment.start,
          blocker.segment.end,
        ) <
        (segment.width + blocker.segment.width) / 2 + clearance - EPSILON
      ) {
        return false
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
        return false
      }
    }
    return true
  }

  const connectorCandidates = (params: {
    terminal: ViaMinimalWindingTerminal
    endpoint: Point2D
    acceptedAttemptSegments: BlockingSegment[]
  }): ConnectorCandidate[] => {
    const { terminal, endpoint, acceptedAttemptSegments } = params
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
            }),
          )
        ) {
          continue
        }
        candidates.push({
          nodeIndex,
          points,
          radialDistance: connectorDistance,
          length: segments.reduce(
            (total, segment) => total + distance(segment.start, segment.end),
            0,
          ),
        })
      }
    }
    return candidates
      .toSorted(
        (first, second) =>
          first.radialDistance - second.radialDistance ||
          first.length - second.length ||
          first.nodeIndex - second.nodeIndex,
      )
      .slice(0, MAX_CONNECTOR_COUNT)
  }

  const visualizeSearch = (params: {
    terminal: ViaMinimalWindingTerminal
    acceptedAttemptSegments: readonly BlockingSegment[]
    expandedPoints: readonly Point2D[]
    frontierPoints: readonly Point2D[]
    bestPath: readonly Point2D[] | null
    expandedStateCount: number
    searchBatch: number
    connectionComplete: boolean
  }): GraphicsObject => {
    const {
      terminal,
      acceptedAttemptSegments,
      expandedPoints,
      frontierPoints,
      bestPath,
      expandedStateCount,
      searchBatch,
      connectionComplete,
    } = params
    return {
      title: `Winding ${bus.busId}: ${terminal.connection.connection.name}`,
      rects: [
        {
          center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
          width: maxX - minX,
          height: maxY - minY,
          fill: "rgba(0, 0, 0, 0)",
          stroke: "rgba(14, 165, 233, 0.9)",
          label: "A* search boundary",
        },
      ],
      points: [
        ...sampledGridPoints.map((point) => ({
          ...point,
          color: "rgba(148, 163, 184, 0.22)",
        })),
        ...frontierPoints.map((point) => ({
          ...point,
          color: "rgba(6, 182, 212, 0.75)",
          label: "open frontier",
        })),
        ...expandedPoints.map((point) => ({
          ...point,
          color: "rgba(244, 63, 94, 0.8)",
          label: "expanded in current step",
        })),
        {
          ...terminal.connection.sourcePoint,
          color: "#f97316",
          label: `source: ${terminal.connection.connection.name}`,
        },
        {
          ...terminal.exitPoint,
          color: "#a855f7",
          label: "target exit",
        },
      ],
      circles: terminals.map((candidate) => ({
        center: candidate.viaPoint,
        radius: viaDiameter / 2,
        fill:
          candidate === terminal
            ? "rgba(250, 204, 21, 0.85)"
            : "rgba(250, 204, 21, 0.25)",
        stroke: candidate === terminal ? "#ca8a04" : "#a16207",
        label:
          candidate === terminal
            ? "active via"
            : `reserved via: ${candidate.connection.connection.name}`,
      })),
      lines: [
        ...acceptedAttemptSegments.map(({ segment, connectionName }) => ({
          points: [segment.start, segment.end],
          strokeColor: "rgba(34, 197, 94, 0.9)",
          strokeWidth: Math.max(traceWidth, gridStep * 0.35),
          label: `accepted: ${connectionName}`,
        })),
        {
          points: [terminal.viaPoint, terminal.exitPoint],
          strokeColor: "rgba(168, 85, 247, 0.45)",
          strokeWidth: Math.max(traceWidth * 0.5, gridStep * 0.15),
          strokeDash: [gridStep, gridStep],
          label: "active via-to-exit search",
        },
        ...(bestPath
          ? [
              {
                points: [...bestPath],
                strokeColor: "#facc15",
                strokeWidth: Math.max(traceWidth, gridStep * 0.45),
                label: "best path so far",
              },
            ]
          : []),
      ],
      texts: [
        {
          x: minX,
          y: maxY + gridStep * 2,
          text: connectionComplete
            ? `connection complete · ${expandedStateCount.toLocaleString()} states`
            : `A* batch ${searchBatch} · ${expandedStateCount.toLocaleString()} states`,
          color: "#0f172a",
          fontSize: Math.max(gridStep * 2.5, 0.5),
          anchorSide: "bottom_left",
        },
      ],
    }
  }

  const routeOneSteps = function* (params: {
    terminal: ViaMinimalWindingTerminal
    acceptedAttemptSegments: BlockingSegment[]
    laneBias: -1 | 0 | 1
  }): Generator<
    {
      expandedStateCount: number
      visualization?: GraphicsObject
    },
    { points: Point2D[] | null; expandedStateCount: number },
    void
  > {
    const { terminal, acceptedAttemptSegments, laneBias } = params
    const starts = connectorCandidates({
      terminal,
      endpoint: terminal.viaPoint,
      acceptedAttemptSegments,
    })
    const ends = connectorCandidates({
      terminal,
      endpoint: terminal.exitPoint,
      acceptedAttemptSegments,
    })
    if (starts.length === 0 || ends.length === 0) {
      return { points: null, expandedStateCount: 0 }
    }
    const endByNode = new Map<number, ConnectorCandidate[]>()
    for (const end of ends) {
      const values = endByNode.get(end.nodeIndex) ?? []
      values.push(end)
      endByNode.set(end.nodeIndex, values)
    }
    const stateCount = nodeCount * 9
    // A* visits a grid edge with several incoming directions. Copper does not
    // change while routing this terminal, so check each edge only once. Keep
    // this cache local: later terminals and route-order attempts add blockers.
    const edgeClearance = new Uint8Array(nodeCount * 8)
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
    let expandedStatesSinceYield = 0
    let searchBatch = 0
    let expandedBatchPoints: Point2D[] = []
    while (heap.size > 0 && expandedStateCount < MAX_EXPANDED_STATE_COUNT) {
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
      expandedStatesSinceYield++
      if (includeVisualization && expandedStatesSinceYield % 50 === 0) {
        expandedBatchPoints.push(nodes[current.node]!.point)
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
          lanePenalty
        const nextState = nextNode * 9 + directionIndex
        if (nextDistance >= distances[nextState]! - EPSILON) continue
        const edgeIndex = current.node * 8 + directionIndex
        if (edgeClearance[edgeIndex] === 0) {
          const clear = segmentIsClear({
            segment: {
              start: node.point,
              end: nextPoint,
              width: traceWidth,
              layer: targetLayer,
            },
            terminal,
            acceptedAttemptSegments,
          })
          edgeClearance[edgeIndex] = clear ? 1 : 2
          edgeClearance[nextNode * 8 + ((directionIndex + 4) % 8)] = clear
            ? 1
            : 2
        }
        if (edgeClearance[edgeIndex] === 2) continue
        distances[nextState] = nextDistance
        previous[nextState] = state
        const remaining = heuristic(nextPoint)
        heap.push({
          node: nextNode,
          direction: directionIndex,
          score: nextDistance + remaining,
        })
      }
      if (expandedStatesSinceYield >= EXPANDED_STATES_PER_STEP) {
        expandedStatesSinceYield = 0
        searchBatch++
        yield {
          expandedStateCount,
          ...(includeVisualization
            ? {
                visualization: visualizeSearch({
                  terminal,
                  acceptedAttemptSegments,
                  expandedPoints: expandedBatchPoints,
                  frontierPoints: heap
                    .sampleEntries(120)
                    .map((entry) => nodes[entry.node]!.point),
                  bestPath: bestGoalPoints,
                  expandedStateCount,
                  searchBatch,
                  connectionComplete: false,
                }),
              }
            : {}),
        }
        expandedBatchPoints = []
      }
    }
    return { points: bestGoalPoints, expandedStateCount }
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
  if (alignGridToPads && preferTargetDirectedLaneBias && viasAreBeforeTargets) {
    initialRouteOrderFactories.push(() => targetOrderedTerminals)
  }
  if (viasAreBeforeTargets) {
    initialRouteOrderFactories.push(() => [
      ...targetOrderedTerminals.slice(1),
      targetOrderedTerminals[0]!,
    ])
  } else if (viasAreAfterTargets) {
    initialRouteOrderFactories.push(() => [...targetOrderedTerminals].reverse())
    if (includeReverseTargetRotation && targetOrderedTerminals.length > 2) {
      // Routing the extreme target first can cut the remaining source field
      // off from the boundary. The forward direction already tries a rotated
      // order; retain its reverse counterpart for local via-site repairs.
      initialRouteOrderFactories.push(() => [
        ...targetOrderedTerminals.slice(0, -1).toReversed(),
        targetOrderedTerminals.at(-1)!,
      ])
    }
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
  const pendingRouteOrders: ViaMinimalWindingTerminal[][] = []
  const seenAdaptiveOrders = new Set<string>()
  const adaptiveRouteOrders = function* () {
    while (true) {
      const pending = pendingRouteOrders.shift()
      const next = pending
        ? { done: false, value: pending }
        : routeOrders.next()
      if (next.done) return
      const key = next.value
        .map((terminal) => terminal.connection.connection.name)
        .join("|")
      if (seenAdaptiveOrders.has(key)) continue
      seenAdaptiveOrders.add(key)
      yield next.value
    }
  }

  const alternatives: FanoutRoutePlan[][] = []
  const seenAlternativeKeys = new Set<string>()
  let routeOrderAttemptCount = 0
  for (const routeOrder of adaptiveRouteOrders()) {
    for (const laneBias of laneBiases) {
      if (
        maximumRouteOrderAttempts !== undefined &&
        routeOrderAttemptCount >= maximumRouteOrderAttempts
      ) {
        return alternatives
      }
      routeOrderAttemptCount++
      const acceptedAttemptSegments: BlockingSegment[] = []
      const routedPointsByConnectionName = new Map<string, Point2D[]>()
      let failed = false
      for (
        let terminalIndex = 0;
        terminalIndex < routeOrder.length;
        terminalIndex++
      ) {
        const terminal = routeOrder[terminalIndex]!
        const connectionSteps = routeOneSteps({
          terminal,
          acceptedAttemptSegments,
          laneBias,
        })
        let connectionResult = connectionSteps.next()
        let searchBatch = 0
        let expandedStateCount = 0
        while (!connectionResult.done) {
          expandedStateCount = connectionResult.value.expandedStateCount
          yield {
            phase: "route-connection",
            routeOrderAttempt: routeOrderAttemptCount,
            connectionIndex: terminalIndex,
            connectionCount: routeOrder.length,
            connectionName: terminal.connection.connection.name,
            searchBatch: ++searchBatch,
            expandedStateCount,
            connectionComplete: false,
            ...(connectionResult.value.visualization
              ? { visualization: connectionResult.value.visualization }
              : {}),
          }
          connectionResult = connectionSteps.next()
        }
        const { points, expandedStateCount: finalExpandedStateCount } =
          connectionResult.value
        expandedStateCount = finalExpandedStateCount
        yield {
          phase: "route-connection",
          routeOrderAttempt: routeOrderAttemptCount,
          connectionIndex: terminalIndex,
          connectionCount: routeOrder.length,
          connectionName: terminal.connection.connection.name,
          searchBatch,
          expandedStateCount,
          connectionComplete: true,
          ...(includeVisualization
            ? {
                visualization: visualizeSearch({
                  terminal,
                  acceptedAttemptSegments,
                  expandedPoints: [],
                  frontierPoints: [],
                  bestPath: points,
                  expandedStateCount,
                  searchBatch,
                  connectionComplete: true,
                }),
              }
            : {}),
        }
        if (!points) {
          if (
            adaptiveRouteOrder &&
            maximumRouteOrderAttempts !== undefined &&
            terminalIndex > 0
          ) {
            const others = routeOrder.filter(
              (candidate) => candidate !== terminal,
            )
            pendingRouteOrders.push([terminal, ...others])
          }
          failed = true
          break
        }
        const connectionName = terminal.connection.connection.name
        routedPointsByConnectionName.set(connectionName, points)
        acceptedAttemptSegments.push(
          ...getSegments(points, traceWidth, targetLayer).map((segment) => ({
            connectionName,
            segment,
          })),
        )
      }
      if (failed) continue
      const plans = terminals.map((terminal) => {
        const targetLayerPoints = routedPointsByConnectionName.get(
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
      if (seenAlternativeKeys.has(alternativeKey)) continue
      seenAlternativeKeys.add(alternativeKey)
      alternatives.push(plans)
      if (alternatives.length >= maximumAlternatives) {
        return alternatives
      }
    }
  }
  return alternatives
}

export function routeViaMinimalWindingAlternatives(
  params: RouteViaMinimalWindingParams,
  maximumAlternatives = 1,
): FanoutRoutePlan[][] {
  const steps = routeViaMinimalWindingAlternativesSteps(
    params,
    maximumAlternatives,
  )
  let result = steps.next()
  while (!result.done) result = steps.next()
  return result.value
}

export function routeViaMinimalWinding(
  params: RouteViaMinimalWindingParams,
): FanoutRoutePlan[] | null {
  return routeViaMinimalWindingAlternatives(params, 1)[0] ?? null
}
