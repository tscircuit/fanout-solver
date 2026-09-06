import {
  PortfolioSingleIntraNodeSolver,
  type SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "./geometry"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import { getViaChannelGridPhase } from "./get-via-channel-grid-phase"
import { normalizeLayeredPath } from "./normalize-layered-path"
import { repairBoundaryRouteTails } from "./repair-boundary-route-tails"
import { fanoutPlansAreClear } from "./route-bus"
import {
  buildViaMinimalWindingPlan,
  type ViaMinimalWindingTerminal,
} from "./route-via-minimal-winding"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  RoutedSegment,
} from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

export interface RouteReservedViaBusesParams {
  srj: SimpleRouteJson
  allBuses: readonly PreparedBus[]
  buses: readonly PreparedBus[]
  targetLayer: string
  transitLayers?: readonly string[]
  terminals: readonly ViaMinimalWindingTerminal[]
  fixedViaPointsByConnectionIndex: ReadonlyMap<number, Point2D>
  sourceEscapePaths?: ReadonlyMap<number, readonly Point2D[]>
  acceptedPlans: readonly FanoutRoutePlan[]
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  maximumIterations?: number
  shuffleSeed?: number
  /** Align a uniform grid and its center keepouts with narrow via channels. */
  tightViaChannels?: boolean
  ripCost?: number
  maximumRipEvents?: number
  /** Additional conservative spacing beyond the physical edge clearance. */
  traceMarginExtra?: number
}

export interface ReservedViaBusesProgress {
  iterations: number
  routedConnectionCount: number
  connectionCount: number
}

type HdPoint = Point2D & { z: number }
interface HdRoute {
  connectionName: string
  route: HdPoint[]
  vias: Point2D[]
}
type NodeWithPorts = ConstructorParameters<
  typeof PortfolioSingleIntraNodeSolver
>[0]["nodeWithPortPoints"]
type MoveArgs = [number, number, number, boolean, number, number, number]

/**
 * The installed portfolio bundles A03 without exporting its class. Keep its
 * adapter in one place and fail closed if the dependency changes this shape.
 * The two overrides supply immutable copper and retain overlapping keepouts;
 * they do not replace the negotiated router's path search or rip-up decisions.
 */
interface NegotiatedRouter {
  solved: boolean
  failed: boolean
  iterations: number
  MAX_ITERATIONS: number
  MAX_RIPS: number
  planeSize: number
  cellCenterX: Float64Array
  cellCenterY: Float64Array
  cellMinX: Float64Array
  cellMaxX: Float64Array
  cellMinY: Float64Array
  cellMaxY: Float64Array
  usedCellsFlat: Int32Array
  connIdToName: string[]
  layerToZ: Map<number, number>
  traceKeepoutRadius: number
  gridToBoundsTransform: {
    a: number
    b: number
    c: number
    d: number
    e: number
    f: number
  }
  activeConnSeg: {
    startCellId: number
    endCellId: number
    startPoint: HdPoint
    endPoint: HdPoint
  }
  nodePool: { cellId: Int32Array }
  heap: { pop(): number }
  _moveCost: number
  _setup(): void
  step(): void
  getOutput(): HdRoute[]
  computeMoveCostAndRips(...args: MoveArgs): void
  markTraceFootprint(
    connectionId: number,
    z: number,
    cellId: number,
    indices: number[],
  ): void
  forEachCellNearCircle(
    x: number,
    y: number,
    radius: number,
    visit: (cellId: number) => void,
  ): void
  shouldSkipFixedPortHalo(flatIndex: number, connectionId: number): boolean
  addSharedOccupant(flatIndex: number, connectionId: number): void
}

type Blocker =
  | { kind: "segment"; connectionName: string; segment: RoutedSegment }
  | {
      kind: "via"
      connectionName: string
      center: Point2D
      diameter: number
      layers: readonly string[]
    }
  | { kind: "obstacle"; obstacle: SimpleRouteJson["obstacles"][number] }

class CopperIndex {
  private buckets = new Map<string, Set<Blocker>>()
  constructor(
    private cellSize: number,
    private margin: number,
  ) {}

  add(blocker: Blocker): void {
    let minX: number, maxX: number, minY: number, maxY: number
    if (blocker.kind === "segment") {
      const s = blocker.segment,
        padding = this.margin + s.width / 2
      minX = Math.min(s.start.x, s.end.x) - padding
      maxX = Math.max(s.start.x, s.end.x) + padding
      minY = Math.min(s.start.y, s.end.y) - padding
      maxY = Math.max(s.start.y, s.end.y) + padding
    } else if (blocker.kind === "via") {
      const padding = this.margin + blocker.diameter / 2
      minX = blocker.center.x - padding
      maxX = blocker.center.x + padding
      minY = blocker.center.y - padding
      maxY = blocker.center.y + padding
    } else {
      const o = blocker.obstacle
      // A circumscribed circle conservatively covers rotated rectangular pads.
      const radius = Math.hypot(o.width, o.height) / 2 + this.margin
      minX = o.center.x - radius
      maxX = o.center.x + radius
      minY = o.center.y - radius
      maxY = o.center.y + radius
    }
    for (let x = this.cell(minX); x <= this.cell(maxX); x++)
      for (let y = this.cell(minY); y <= this.cell(maxY); y++) {
        const key = `${x},${y}`,
          bucket = this.buckets.get(key) ?? new Set<Blocker>()
        bucket.add(blocker)
        this.buckets.set(key, bucket)
      }
  }

  nearby(a: Point2D, b: Point2D = a): Blocker[] {
    const result = new Set<Blocker>()
    for (
      let x = this.cell(Math.min(a.x, b.x));
      x <= this.cell(Math.max(a.x, b.x));
      x++
    )
      for (
        let y = this.cell(Math.min(a.y, b.y));
        y <= this.cell(Math.max(a.y, b.y));
        y++
      ) {
        for (const blocker of this.buckets.get(`${x},${y}`) ?? [])
          result.add(blocker)
      }
    return [...result]
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellSize)
  }
}

function compactPoints(points: HdPoint[]): HdPoint[] {
  const result: HdPoint[] = []
  for (const point of points) {
    const a = result.at(-2),
      b = result.at(-1)
    if (a && b && a.z === b.z && b.z === point.z) {
      const ux = b.x - a.x,
        uy = b.y - a.y,
        vx = point.x - b.x,
        vy = point.y - b.y
      if (Math.abs(ux * vy - uy * vx) < 1e-10 && ux * vx + uy * vy >= 0)
        result.pop()
    }
    result.push(point)
  }
  return result
}

function convertRoutes(
  params: RouteReservedViaBusesParams,
  routes: HdRoute[],
  paths: ReadonlyMap<number, readonly Point2D[]>,
): FanoutRoutePlan[] | null {
  const owners = new Map(
    params.buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connection.name, { bus, connection }] as const,
      ),
    ),
  )
  const terminals = new Map(
    params.terminals.map((terminal) => [
      terminal.connection.connection.name,
      terminal,
    ]),
  )
  const plans: FanoutRoutePlan[] = []
  for (const hdRoute of routes) {
    const owner = owners.get(hdRoute.connectionName),
      terminal = terminals.get(hdRoute.connectionName)
    if (!owner || !terminal) return null
    const { bus, connection } = owner,
      points = compactPoints(hdRoute.route),
      sourcePoints = paths.get(connection.connectionIndex)!
    if (
      !points.length ||
      distance(points[0]!, terminal.viaPoint) > 1e-7 ||
      distance(points.at(-1)!, terminal.exitPoint) > 1e-7 ||
      points.some(
        (point) =>
          !(bus.allowedLayers ?? params.layerNames).includes(
            params.layerNames[point.z]!,
          ),
      )
    )
      return null
    const base = buildViaMinimalWindingPlan({
      ...params,
      bus,
      terminal,
      targetLayerPoints: [terminal.viaPoint, terminal.exitPoint],
      sourceEscapePoints: sourcePoints,
      allowBlindAndBuriedVias: false,
    })
    const firstVia = base.trace.route.findIndex(
      (point) => point.route_type === "via",
    )
    if (firstVia < 0) return null
    const traceRoute = base.trace.route.slice(0, firstVia + 2)
    const segments: RoutedSegment[] = sourcePoints
      .slice(1)
      .map((point, index) => ({
        start: sourcePoints[index]!,
        end: point,
        width: params.traceWidth,
        layer: connection.sourceLayer,
      }))
    const additionalVias: NonNullable<FanoutRoutePlan["additionalVias"]> = []
    for (let index = 1; index < points.length; index++) {
      const point = points[index]!,
        previous = points[index - 1]!,
        fromLayer = params.layerNames[previous.z]!,
        toLayer = params.layerNames[point.z]!
      if (fromLayer !== toLayer) {
        if (distance(previous, point) > 1e-7) return null
        additionalVias.push({
          center: { x: point.x, y: point.y },
          diameter: params.viaDiameter,
          holeDiameter: params.viaHoleDiameter,
          fromLayer,
          toLayer,
          spanLayers: [...params.layerNames],
        })
        traceRoute.push({
          route_type: "via",
          x: point.x,
          y: point.y,
          from_layer: fromLayer,
          to_layer: toLayer,
          via_diameter: params.viaDiameter,
          via_hole_diameter: params.viaHoleDiameter,
        })
      } else if (distance(previous, point) > 1e-9) {
        segments.push({
          start: { x: previous.x, y: previous.y },
          end: { x: point.x, y: point.y },
          width: params.traceWidth,
          layer: toLayer,
        })
      }
      traceRoute.push({
        route_type: "wire",
        x: point.x,
        y: point.y,
        layer: toLayer,
        width: params.traceWidth,
      })
    }
    plans.push({
      ...base,
      trace: { ...base.trace, route: traceRoute },
      segments,
      additionalVias,
      length: segments.reduce(
        (sum, segment) => sum + distance(segment.start, segment.end),
        0,
      ),
    })
  }
  return plans
}

/** Negotiated fixed-via routing; only fully validated, complete buses are returned. */
export function* routeReservedViaBusesSteps(
  params: RouteReservedViaBusesParams,
): Generator<ReservedViaBusesProgress, FanoutRoutePlan[] | null, unknown> {
  const {
    buses,
    allBuses,
    targetLayer,
    layerNames,
    traceWidth,
    clearance,
    viaDiameter,
    srj,
  } = params
  const maximumIterations = params.maximumIterations ?? 30_000_000
  if (!Number.isSafeInteger(maximumIterations) || maximumIterations < 1)
    throw new Error("maximumIterations must be a positive safe integer")
  const ripCost = params.ripCost ?? 8
  if (!Number.isFinite(ripCost) || ripCost <= 0)
    throw new Error("ripCost must be finite and positive")
  if (
    params.maximumRipEvents !== undefined &&
    (!Number.isSafeInteger(params.maximumRipEvents) ||
      params.maximumRipEvents < 1)
  )
    throw new Error("maximumRipEvents must be a positive safe integer")
  const marginExtra = params.traceMarginExtra ?? traceWidth / 2
  if (!Number.isFinite(marginExtra) || marginExtra < 0)
    throw new Error("traceMarginExtra must be finite and non-negative")
  const routingLayers = [
    ...new Set([targetLayer, ...(params.transitLayers ?? [])]),
  ]
  const targetZ = layerNames.indexOf(targetLayer)
  if (
    buses.length === 0 ||
    targetZ < 0 ||
    routingLayers.some((layer) => !layerNames.includes(layer))
  )
    return null
  const connections = buses.flatMap((bus) => bus.connections),
    expected = new Set(
      connections.map((connection) => connection.connectionIndex),
    )
  if (
    expected.size !== connections.length ||
    params.terminals.length !== connections.length ||
    new Set(
      params.terminals.map((terminal) => terminal.connection.connectionIndex),
    ).size !== expected.size ||
    params.terminals.some(
      (terminal) => !expected.has(terminal.connection.connectionIndex),
    )
  )
    return null
  if (
    buses.some(
      (bus) =>
        bus.termination.type !== "boundary" ||
        !(bus.allowedLayers ?? layerNames).includes(targetLayer),
    ) ||
    allBuses.some((bus) =>
      bus.connections.some((connection) =>
        routingLayers.includes(connection.sourceLayer),
      ),
    )
  )
    return null
  const bounds = buses[0]!.sharedBoundary
  if (
    buses.some((bus) =>
      Object.keys(bounds).some(
        (key) =>
          bus.sharedBoundary[key as keyof Bounds] !==
          bounds[key as keyof Bounds],
      ),
    )
  )
    return null
  const paths = new Map<number, readonly Point2D[]>(),
    owners = new Map<string, PreparedBus>()
  const index = new CopperIndex(
    Math.max(0.5, viaDiameter * 2),
    Math.max(traceWidth, viaDiameter) / 2 + clearance + 1e-7,
  )
  for (const obstacle of srj.obstacles)
    index.add({ kind: "obstacle", obstacle })
  for (const bus of allBuses)
    for (const connection of bus.connections) {
      owners.set(connection.connection.name, bus)
      const site = params.fixedViaPointsByConnectionIndex.get(
        connection.connectionIndex,
      )
      if (!site) return null
      const points = params.sourceEscapePaths?.get(
        connection.connectionIndex,
      ) ?? [connection.sourcePoint, site]
      if (
        points.length < 2 ||
        distance(points[0]!, connection.sourcePoint) > 1e-7 ||
        distance(points.at(-1)!, site) > 1e-7
      )
        return null
      paths.set(connection.connectionIndex, points)
      index.add({
        kind: "via",
        connectionName: connection.connection.name,
        center: site,
        diameter: viaDiameter,
        layers: layerNames,
      })
      for (let i = 1; i < points.length; i++)
        index.add({
          kind: "segment",
          connectionName: connection.connection.name,
          segment: {
            start: points[i - 1]!,
            end: points[i]!,
            width: traceWidth,
            layer: connection.sourceLayer,
          },
        })
    }
  for (const terminal of params.terminals)
    if (
      distance(
        terminal.viaPoint,
        params.fixedViaPointsByConnectionIndex.get(
          terminal.connection.connectionIndex,
        )!,
      ) > 1e-7
    )
      return null
  for (const plan of params.acceptedPlans) {
    for (const segment of [
      ...plan.segments,
      ...(plan.planeEndpointSegments ?? []),
    ])
      index.add({
        kind: "segment",
        connectionName: plan.connectionName,
        segment,
      })
    for (const via of [
      plan.via,
      ...(plan.additionalVias ?? []),
      plan.planeEndpointVia,
    ])
      if (via)
        index.add({
          kind: "via",
          connectionName: plan.connectionName,
          ...via,
          layers: via.spanLayers,
        })
  }
  for (const copper of getAllRoutedTraceCopper(srj, false)) {
    for (const segment of copper.segments)
      index.add({
        kind: "segment",
        connectionName: copper.connectionName,
        segment,
      })
    for (const via of copper.vias)
      index.add({
        kind: "via",
        connectionName: copper.connectionName,
        ...via,
        layers: via.spanLayers,
      })
  }
  const node: NodeWithPorts = {
    capacityMeshNodeId: "reserved-via-buses",
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    },
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    availableZ: routingLayers.map((layer) => layerNames.indexOf(layer)),
    portPoints: params.terminals.flatMap((terminal) =>
      [terminal.viaPoint, terminal.exitPoint].map((point) => ({
        ...point,
        z: targetZ,
        connectionName: terminal.connection.connection.name,
        rootConnectionName: terminal.connection.connection.name,
      })),
    ),
  }
  if (params.tightViaChannels) {
    const phase = getViaChannelGridPhase({
      vias: [...params.fixedViaPointsByConnectionIndex].map(
        ([connectionIndex, center]) => ({
          connectionIndex,
          center,
          diameter: viaDiameter,
        }),
      ),
      activeConnectionIndices: expected,
      traceWidth,
      clearance,
      gridStep: traceWidth,
    })
    for (const axis of ["x", "y"] as const) {
      const first = (axis === "x" ? bounds.minX : bounds.minY) + traceWidth / 2
      node.center[axis] +=
        phase[axis] -
        (first + Math.round((phase[axis] - first) / traceWidth) * traceWidth)
    }
  }
  const factory = new PortfolioSingleIntraNodeSolver({
    nodeWithPortPoints: node,
    traceWidth,
    viaDiameter,
  })
  const candidate = factory.generateSolver({
    HIGH_DENSITY_A03: true,
  }) as unknown as NegotiatedRouter
  if (
    typeof candidate.computeMoveCostAndRips !== "function" ||
    typeof candidate.markTraceFootprint !== "function" ||
    typeof candidate.addSharedOccupant !== "function"
  )
    return null
  const Constructor = candidate.constructor as new (
    options: object,
  ) => NegotiatedRouter
  const router = new Constructor({
    nodeWithPortPoints: node,
    highResolutionCellSize: traceWidth,
    lowResolutionCellSize: traceWidth,
    traceThickness: traceWidth,
    traceMargin: clearance + marginExtra,
    viaDiameter,
    maxCellCount: 160_000 * routingLayers.length,
    effort: 20,
    hyperParameters: {
      shuffleSeed: params.shuffleSeed ?? 1,
      greedyMultiplier: 1.5,
      ripCost,
    },
  })
  const setup = router._setup.bind(router),
    move = router.computeMoveCostAndRips.bind(router)
  let previousCell = -1
  const viaCells = new Map<number, boolean>()
  const edgeBlockers = new Map<number, Blocker[]>()
  const pointAt = (cell: number): Point2D => ({
    x: router.cellCenterX[cell]!,
    y: router.cellCenterY[cell]!,
  })
  const withinBounds = (point: Point2D): boolean =>
    point.x >= bounds.minX - 1e-9 &&
    point.x <= bounds.maxX + 1e-9 &&
    point.y >= bounds.minY - 1e-9 &&
    point.y <= bounds.maxY + 1e-9
  const extraViaIsClear = (cell: number): boolean => {
    const cached = viaCells.get(cell)
    if (cached !== undefined) return cached
    const point = pointAt(cell)
    const clear = index.nearby(point).every((blocker) => {
      if (blocker.kind === "via")
        return (
          distance(point, blocker.center) >=
          (viaDiameter + blocker.diameter) / 2 + clearance - 1e-9
        )
      if (blocker.kind === "segment")
        return (
          distancePointToSegment(
            point,
            blocker.segment.start,
            blocker.segment.end,
          ) >=
          (viaDiameter + blocker.segment.width) / 2 + clearance - 1e-9
        )
      return (
        distanceSegmentToObstacle(
          { start: point, end: point, width: 0, layer: targetLayer },
          blocker.obstacle,
        ) >=
        viaDiameter / 2 + clearance - 1e-9
      )
    })
    viaCells.set(cell, clear)
    return clear
  }
  router._setup = () => {
    setup()
    if (router.failed) return
    router.MAX_ITERATIONS = maximumIterations
    if (params.maximumRipEvents !== undefined)
      router.MAX_RIPS = params.maximumRipEvents
    // Static tests and emitted copper must use exactly the same coordinates.
    router.gridToBoundsTransform = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 }
    const pop = router.heap.pop.bind(router.heap)
    router.heap.pop = () => {
      const item = pop()
      previousCell = router.nodePool.cellId[item]!
      return item
    }
  }
  router.markTraceFootprint = (connectionId, z, sourceCell, indices) => {
    const point = pointAt(sourceCell),
      radius = router.traceKeepoutRadius
    router.forEachCellNearCircle(point.x, point.y, radius, (cell) => {
      const dx = params.tightViaChannels
          ? router.cellCenterX[cell]! - point.x
          : Math.max(
              router.cellMinX[cell]! - point.x,
              0,
              point.x - router.cellMaxX[cell]!,
            ),
        dy = params.tightViaChannels
          ? router.cellCenterY[cell]! - point.y
          : Math.max(
              router.cellMinY[cell]! - point.y,
              0,
              point.y - router.cellMaxY[cell]!,
            )
      // Center keepouts retain legal two-lane channels on a uniform grid.
      // Exact validation below also checks the off-grid terminal connectors.
      const effectiveRadius = radius - (params.tightViaChannels ? 1e-9 : 0)
      if (
        params.tightViaChannels
          ? dx * dx + dy * dy >= effectiveRadius * effectiveRadius
          : dx * dx + dy * dy > effectiveRadius * effectiveRadius
      )
        return
      const flat = z * router.planeSize + cell
      if (
        cell !== sourceCell &&
        router.shouldSkipFixedPortHalo(flat, connectionId)
      )
        return
      const existing = router.usedCellsFlat[flat]!
      // Keep all halo owners: ripping one route must not erase another's halo.
      if (existing !== -1 && existing !== connectionId)
        router.addSharedOccupant(flat, connectionId)
      else router.usedCellsFlat[flat] = connectionId
      indices.push(flat)
    })
  }
  const segmentIsClear = (
    a: Point2D,
    b: Point2D,
    layer: string,
    name: string,
    blockers = index.nearby(a, b),
  ): boolean =>
    blockers.every((blocker) => {
      if (blocker.kind === "obstacle")
        return (
          !blocker.obstacle.layers.includes(layer) ||
          distanceSegmentToObstacle(
            { start: a, end: b, width: traceWidth, layer },
            blocker.obstacle,
          ) >=
            traceWidth / 2 + clearance - 1e-9
        )
      if (blocker.connectionName === name) return true
      if (blocker.kind === "via")
        return (
          !blocker.layers.includes(layer) ||
          distancePointToSegment(blocker.center, a, b) >=
            (traceWidth + blocker.diameter) / 2 + clearance - 1e-9
        )
      return (
        blocker.segment.layer !== layer ||
        distanceSegmentToSegment(
          a,
          b,
          blocker.segment.start,
          blocker.segment.end,
        ) >=
          (traceWidth + blocker.segment.width) / 2 + clearance - 1e-9
      )
    })
  router.computeMoveCostAndRips = (...args) => {
    const [connectionId, z, nextCell, isVia] = args,
      name = router.connIdToName[connectionId]!,
      layer = layerNames[router.layerToZ.get(z)!]!,
      owner = owners.get(name)!,
      segment = router.activeConnSeg
    if (
      !(owner.allowedLayers ?? layerNames).includes(layer) ||
      (isVia && !extraViaIsClear(nextCell))
    ) {
      router._moveCost = -1
      return
    }
    const a =
        previousCell === segment.startCellId
          ? segment.startPoint
          : pointAt(previousCell),
      b = nextCell === segment.endCellId ? segment.endPoint : pointAt(nextCell)
    if (!withinBounds(a) || !withinBounds(b)) {
      router._moveCost = -1
      return
    }
    const edgeKey = previousCell * router.planeSize + nextCell
    const usesTerminal =
      previousCell === segment.startCellId || nextCell === segment.endCellId
    let blockers = usesTerminal ? undefined : edgeBlockers.get(edgeKey)
    if (!blockers) {
      blockers = index.nearby(a, b)
      if (!usesTerminal) edgeBlockers.set(edgeKey, blockers)
    }
    const clear = segmentIsClear(a, b, layer, name, blockers)
    if (!clear) {
      router._moveCost = -1
      return
    }
    move(...args)
  }
  while (!router.solved && !router.failed) {
    for (
      let batch = 0;
      batch < 5_000 && !router.solved && !router.failed;
      batch++
    )
      router.step()
    if (router.failed) return null
    yield {
      iterations: router.iterations,
      routedConnectionCount: router.getOutput().length,
      connectionCount: connections.length,
    }
  }
  if (!router.solved || router.failed) return null
  let routes = router.getOutput()
  if (
    routes.length !== connections.length ||
    new Set(routes.map((route) => route.connectionName)).size !==
      connections.length
  )
    return null
  const alreadyRouted = new Set([
    ...expected,
    ...params.acceptedPlans.map((plan) => plan.connectionIndex),
  ])
  const prefixes = allBuses.flatMap((bus) =>
    bus.connections
      .filter((connection) => !alreadyRouted.has(connection.connectionIndex))
      .map((connection) => {
        const viaPoint = params.fixedViaPointsByConnectionIndex.get(
            connection.connectionIndex,
          )!,
          prefixLayer =
            bus.termination.type === "plane"
              ? bus.termination.layer
              : (bus.allowedLayers ?? layerNames).find(
                  (layer) => layer !== connection.sourceLayer,
                )!
        return buildViaMinimalWindingPlan({
          ...params,
          bus,
          terminal: { connection, viaPoint, exitPoint: viaPoint },
          targetLayer: prefixLayer,
          targetLayerPoints: [viaPoint],
          sourceEscapePoints: paths.get(connection.connectionIndex),
          allowBlindAndBuriedVias: false,
        })
      }),
  )
  const rawPlans = convertRoutes(params, routes, paths)
  if (!rawPlans) return null
  const repairedPlans = repairBoundaryRouteTails({
    ...params,
    inputSrj: srj,
    plans: rawPlans,
    preparedBuses: buses,
    reservedPlans: [...params.acceptedPlans, ...prefixes],
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  })
  if (!repairedPlans) return null
  routes = repairedPlans.map((plan) => {
    const firstVia = plan.trace.route.findIndex(
      (point) => point.route_type === "via",
    )
    return {
      connectionName: plan.connectionName,
      route: plan.trace.route
        .slice(firstVia + 1)
        .flatMap((point) =>
          point.route_type === "wire"
            ? [{ x: point.x, y: point.y, z: layerNames.indexOf(point.layer) }]
            : [],
        ),
      vias: (plan.additionalVias ?? []).map((via) => via.center),
    }
  })
  const addRouteCopper = (route: HdRoute): void => {
    for (let i = 1; i < route.route.length; i++) {
      const a = route.route[i - 1]!,
        b = route.route[i]!
      if (a.z === b.z)
        index.add({
          kind: "segment",
          connectionName: route.connectionName,
          segment: {
            start: a,
            end: b,
            width: traceWidth,
            layer: layerNames[a.z]!,
          },
        })
    }
    for (const center of route.vias)
      index.add({
        kind: "via",
        connectionName: route.connectionName,
        center,
        diameter: viaDiameter,
        layers: layerNames,
      })
  }
  for (const route of routes) addRouteCopper(route)
  for (const route of routes) {
    const terminal = params.terminals.find(
      (item) => item.connection.connection.name === route.connectionName,
    )!
    const normalized = normalizeLayeredPath({
      points: compactPoints(route.route),
      chamfer: traceWidth / 4,
      segmentIsClear: (a, b) => {
        for (const point of [a, b]) {
          if (!withinBounds(point)) return false
          const onBoundary =
            Math.abs(point.x - bounds.minX) < 1e-7 ||
            Math.abs(point.x - bounds.maxX) < 1e-7 ||
            Math.abs(point.y - bounds.minY) < 1e-7 ||
            Math.abs(point.y - bounds.maxY) < 1e-7
          if (onBoundary && distance(point, terminal.exitPoint) > 1e-7)
            return false
        }
        return segmentIsClear(a, b, layerNames[a.z]!, route.connectionName)
      },
    })
    if (!normalized) return null
    route.route = normalized
    // Keep both versions while normalizing the remaining paths. This is
    // conservative and prevents a later corner from consuming earlier copper.
    addRouteCopper(route)
  }
  const plans = convertRoutes(params, routes, paths)
  if (
    !plans ||
    !fanoutPlansAreClear({
      plans,
      srj,
      sharedBoundary: bounds,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    })
  )
    return null
  const traces = [
    ...(srj.traces ?? []),
    ...[...plans, ...params.acceptedPlans, ...prefixes].flatMap((plan) => [
      plan.trace,
      ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
    ]),
  ]
  return validateRoutedCopperDrc({
    inputSrj: srj,
    routedSrj: { ...srj, traces },
    clearance,
    allowBlindAndBuriedVias: false,
  }).valid
    ? plans
    : null
}
