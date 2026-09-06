import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import { getViaSpanLayers } from "./layer-names"
import { matchAngularlyOrderedLocalVias } from "./match-angularly-ordered-local-vias"
import {
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaSites,
  type DogboneViaSiteGeometryRules,
} from "./match-component-dogbone-via-sites"
import { routeSingleLayerWithAdaptiveExitsSteps } from "./route-single-layer-adaptive-exits"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
  RoutedSegment,
  RoutedVia,
} from "./types"

const EPSILON = 1e-9
export interface PeripheralSourceEscape {
  connectionIndex: number
  connectionName: string
  segments: RoutedSegment[]
  via: RoutedVia
}
export interface PeripheralSourceEscapes {
  sourceEscapes: PeripheralSourceEscape[]
  viaPointsByConnectionIndex: Map<number, Point2D>
  remoteConnectionIndices: Set<number>
  localBus: PreparedBus
  sourceBoundary: Bounds
}
export interface PeripheralSourceEscapeParams {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  bus: PreparedBus
  targetLayer: string
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  allowBlindAndBuriedVias?: boolean
  initialViaPoints?: ReadonlyMap<number, Point2D>
  targetPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
  targetLayerByBusId?: ReadonlyMap<string, string>
}

function chamfer(points: Point2D[], amount: number): Point2D[] {
  const result = [points[0]!]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!,
      p = points[i]!,
      b = points[i + 1]!
    const dx = p.x - a.x,
      dy = p.y - a.y,
      ex = b.x - p.x,
      ey = b.y - p.y
    const before = Math.hypot(dx, dy),
      after = Math.hypot(ex, ey)
    if (before < EPSILON || after < EPSILON) continue
    if (Math.abs(dx * ex + dy * ey) < EPSILON) {
      const trim = Math.min(amount, before / 2, after / 2)
      result.push(
        { x: p.x - (dx / before) * trim, y: p.y - (dy / before) * trim },
        { x: p.x + (ex / after) * trim, y: p.y + (ey / after) * trim },
      )
    } else result.push(p)
  }
  result.push(points.at(-1)!)
  return result.filter(
    (p, i) => i === 0 || distance(p, result[i - 1]!) > EPSILON,
  )
}

/** A deterministic longest peripheral subsequence that preserves target order. */
function selectOrderedPaths(
  paths: FanoutRoutePlan[],
  ranks: ReadonlyMap<number, number>,
  center: Point2D,
): FanoutRoutePlan[] {
  const ordered = paths.toSorted(
    (a, b) =>
      Math.atan2(a.exitPoint.y - center.y, a.exitPoint.x - center.x) -
      Math.atan2(b.exitPoint.y - center.y, b.exitPoint.x - center.x),
  )
  const lexicographicallyEarlier = (
    a: FanoutRoutePlan[],
    b: FanoutRoutePlan[],
  ) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const difference =
        ranks.get(a[i]!.connectionIndex)! - ranks.get(b[i]!.connectionIndex)!
      if (difference) return difference < 0
    }
    return false
  }
  const better = (a: FanoutRoutePlan[], b: FanoutRoutePlan[]) =>
    a.length > b.length ||
    (a.length === b.length && lexicographicallyEarlier(a, b))
  const suffixes: FanoutRoutePlan[][] = []
  for (let i = ordered.length - 1; i >= 0; i--) {
    let suffix: FanoutRoutePlan[] = []
    for (let j = i + 1; j < ordered.length; j++)
      if (
        ranks.get(ordered[j]!.connectionIndex)! >
          ranks.get(ordered[i]!.connectionIndex)! &&
        better(suffixes[j]!, suffix)
      )
        suffix = suffixes[j]!
    suffixes[i] = [ordered[i]!, ...suffix]
  }
  return suffixes.reduce(
    (best, current) => (better(current, best) ? current : best),
    [],
  )
}

/**
 * Escape an ordered subset on its source layer before assigning the remaining
 * vias. Returned prefixes stop at the first via; the caller must complete and
 * validate the whole atomic bus before accepting any of them.
 */
export function* routePeripheralSourceEscapesSteps(
  params: PeripheralSourceEscapeParams,
): Generator<void, PeripheralSourceEscapes | null, unknown> {
  const { bus, srj, traceWidth: w, clearance: c, viaDiameter: d } = params
  // This adjacent-band construction currently handles a right edge from the
  // upper source perimeter. Other orientations retain the general fallback.
  if (
    bus.termination.type !== "boundary" ||
    bus.exitEdge !== "right" ||
    bus.connections.length < 6 ||
    bus.connections.some((connection) => connection.sourceLayer !== "top") ||
    !(bus.allowedLayers ?? params.layerNames).includes(params.targetLayer) ||
    params.targetLayer === "top"
  )
    return null
  const sourceObstacles = bus.componentObstacles.filter((o) =>
    o.layers.includes("top"),
  )
  if (!sourceObstacles.length) return null
  const padBounds = {
    minX: Math.min(...sourceObstacles.map((o) => o.center.x - o.width / 2)),
    maxX: Math.max(...sourceObstacles.map((o) => o.center.x + o.width / 2)),
    minY: Math.min(...sourceObstacles.map((o) => o.center.y - o.height / 2)),
    maxY: Math.max(...sourceObstacles.map((o) => o.center.y + o.height / 2)),
  }
  const center = {
    x: (padBounds.minX + padBounds.maxX) / 2,
    y: (padBounds.minY + padBounds.maxY) / 2,
  }
  const pitch = w + c,
    padPitch = Math.max(bus.pitchX, bus.pitchY)
  if (!Number.isFinite(padPitch) || padPitch <= 0) return null
  const halfWidth =
    Math.ceil(
      ((padBounds.maxX - padBounds.minX) / 2 + padPitch + pitch) / pitch,
    ) * pitch
  const halfHeight =
    Math.ceil(
      ((padBounds.maxY - padBounds.minY) / 2 + padPitch + pitch) / pitch,
    ) * pitch
  const sourceBoundary = {
    minX: center.x - halfWidth,
    maxX: center.x + halfWidth,
    minY: center.y - halfHeight,
    maxY: center.y + halfHeight,
  }
  if (
    sourceBoundary.minX <= bus.sharedBoundary.minX ||
    sourceBoundary.maxX >= bus.sharedBoundary.maxX ||
    sourceBoundary.minY <= bus.sharedBoundary.minY ||
    sourceBoundary.maxY >= bus.sharedBoundary.maxY
  )
    return null
  const singletonBuses = bus.connections.map((connection, index) => ({
    ...bus,
    busId: `${bus.busId}:source-perimeter:${index}`,
    sharedBoundary: sourceBoundary,
    preferredExit: undefined,
    exitEdge: undefined,
    connections: [
      {
        ...connection,
        exitTargetPoint: undefined,
        hasExplicitLayeredExitTarget: false,
        hasExplicitExitTarget: false,
      },
    ],
  }))
  const paths = yield* routeSingleLayerWithAdaptiveExitsSteps({
    srj,
    buses: singletonBuses,
    traceWidth: w,
    clearance: c,
  })
  if (!paths || paths.length !== bus.connections.length) return null
  const target = (connection: PreparedConnection): Point2D =>
    params.targetPointsByConnectionIndex?.get(connection.connectionIndex) ?? {
      x: bus.sharedBoundary.maxX,
      y: (connection.exitTargetPoint ?? connection.targetPoint).y,
    }
  const targetOrdered = bus.connections.toSorted(
    (a, b) =>
      target(a).y - target(b).y || a.connectionIndex - b.connectionIndex,
  )
  const ranks = new Map(
    targetOrdered.map((connection, i) => [connection.connectionIndex, i]),
  )
  const selected = selectOrderedPaths(paths, ranks, center)
  if (
    selected.length < 3 ||
    selected.length >= bus.connections.length ||
    selected.some(
      (p) =>
        Math.abs(p.exitPoint.y - sourceBoundary.maxY) > EPSILON &&
        (Math.abs(p.exitPoint.x - sourceBoundary.minX) > EPSILON ||
          p.exitPoint.y < center.y),
    )
  )
    return null
  const byIndex = new Map(
    params.buses.flatMap((b) =>
      b.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus: b, connection }] as const,
      ),
    ),
  )
  const viaTargetX = bus.sharedBoundary.maxX - Math.max(padPitch / 2, d / 2 + c)
  const viaTraceDistance = d / 2 + w / 2 + c
  const lastColumn = viaTargetX - viaTraceDistance - 1e-5
  const firstColumn = lastColumn - (selected.length - 1) * pitch
  const lastHeight = bus.sharedBoundary.maxY - pitch
  const firstHeight = lastHeight - (selected.length - 1) * pitch
  if (
    firstColumn <= padBounds.maxX + viaTraceDistance ||
    firstHeight <= sourceBoundary.maxY + pitch
  )
    return null
  const makeVia = (
    connection: PreparedConnection,
    point: Point2D,
  ): RoutedVia => {
    const owner = byIndex.get(connection.connectionIndex)!.bus
    const toLayer =
      owner.busId === bus.busId
        ? params.targetLayer
        : owner.termination.type === "plane"
          ? owner.termination.layer
          : (params.targetLayerByBusId?.get(owner.busId) ??
            (owner.allowedLayers ?? params.layerNames).find(
              (l) => l !== connection.sourceLayer,
            ))
    if (!toLayer)
      throw new Error(
        "FanoutSolver: missing target layer for peripheral via assignment",
      )
    return {
      center: point,
      diameter: d,
      holeDiameter: params.viaHoleDiameter,
      fromLayer: connection.sourceLayer,
      toLayer,
      spanLayers: getViaSpanLayers({
        fromLayer: connection.sourceLayer,
        toLayer,
        layerNames: params.layerNames,
        allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
      }),
    }
  }
  const makeEscape = (
    connection: PreparedConnection,
    points: Point2D[],
  ): PeripheralSourceEscape => ({
    connectionIndex: connection.connectionIndex,
    connectionName: connection.connection.name,
    segments: points.slice(1).map((end, i) => ({
      start: points[i]!,
      end,
      width: w,
      layer: connection.sourceLayer,
    })),
    via: makeVia(connection, points.at(-1)!),
  })
  const fixed: PeripheralSourceEscape[] = selected.map((path, i) => {
    const connection = byIndex.get(path.connectionIndex)!.connection,
      exit = target(connection)
    const height = firstHeight + i * pitch,
      column = firstColumn + i * pitch
    return makeEscape(
      connection,
      chamfer(
        [
          path.segments[0]!.start,
          ...path.segments.map((s) => s.end),
          { x: path.exitPoint.x, y: height },
          { x: column, y: height },
          { x: column, y: exit.y },
          { x: viaTargetX, y: exit.y },
        ],
        w,
      ),
    )
  })
  const remoteConnectionIndices = new Set(fixed.map((p) => p.connectionIndex))
  const clears = (
    escape: PeripheralSourceEscape,
    others: readonly PeripheralSourceEscape[],
  ) => {
    const connection = byIndex.get(escape.connectionIndex)!.connection
    if (
      escape.segments.some((segment) =>
        [segment.start, segment.end].some(
          (p) =>
            p.x < bus.sharedBoundary.minX - EPSILON ||
            p.x > bus.sharedBoundary.maxX + EPSILON ||
            p.y < bus.sharedBoundary.minY - EPSILON ||
            p.y > bus.sharedBoundary.maxY + EPSILON,
        ),
      )
    )
      return false
    for (const obstacle of srj.obstacles) {
      if (
        obstacle.layers.some((layer) =>
          escape.via.spanLayers.includes(layer),
        ) &&
        distancePointToObstacle(escape.via.center, obstacle) <
          d / 2 + c - EPSILON
      )
        return false
      if (
        obstacle !== connection.sourceObstacle &&
        escape.segments.some(
          (segment) =>
            obstacle.layers.includes(segment.layer) &&
            distanceSegmentToObstacle(segment, obstacle) < w / 2 + c - EPSILON,
        )
      )
        return false
    }
    for (const other of others) {
      if (escape.connectionIndex === other.connectionIndex) continue
      if (distance(escape.via.center, other.via.center) < d + c - EPSILON)
        return false
      if (
        escape.segments.some(
          (s) =>
            distancePointToSegment(other.via.center, s.start, s.end) <
            viaTraceDistance - EPSILON,
        ) ||
        other.segments.some(
          (s) =>
            distancePointToSegment(escape.via.center, s.start, s.end) <
            viaTraceDistance - EPSILON,
        )
      )
        return false
      if (
        escape.segments.some((a) =>
          other.segments.some((b) => !segmentsAreClear(a, b, c)),
        )
      )
        return false
    }
    return true
  }
  if (fixed.some((escape) => !clears(escape, fixed))) return null
  const remainingBuses = () => {
    const held = new Set(fixed.map((p) => p.connectionIndex))
    return params.buses
      .map((b) => ({
        ...b,
        connections: b.connections.filter(
          (connection) => !held.has(connection.connectionIndex),
        ),
      }))
      .filter((b) => b.connections.length)
  }
  const rules = (): DogboneViaSiteGeometryRules => ({
    viaDiameter: d,
    viaHoleDiameter: params.viaHoleDiameter,
    traceWidth: w,
    clearance: c,
    additionalObstacles: srj.obstacles,
    maximumSearchStates: 300_000,
    blockingSegments: fixed.flatMap((p) =>
      p.segments.map((segment) => ({
        connectionIndex: p.connectionIndex,
        segment,
      })),
    ),
    blockingVias: fixed.map((p) => ({
      connectionIndex: p.connectionIndex,
      ...p.via,
    })),
    preferredViaPointsByConnectionIndex: params.initialViaPoints,
  })
  let remaining = remainingBuses()
  const available = new Set(
    getComponentDogboneViaSiteCandidates(remaining, rules()).map(
      (p) => p.connectionIndex,
    ),
  )
  for (const owner of remaining)
    for (const connection of owner.connections) {
      if (available.has(connection.connectionIndex)) continue
      if (owner.termination.type !== "plane") return null
      const source = connection.sourcePoint,
        obstacle = connection.sourceObstacle
      const directions = [
        { x: 0, y: 1, gap: padBounds.maxY - source.y },
        { x: -1, y: 0, gap: source.x - padBounds.minX },
        { x: 0, y: -1, gap: source.y - padBounds.minY },
        { x: 1, y: 0, gap: padBounds.maxX - source.x },
      ].sort((a, b) => a.gap - b.gap)
      let additional: PeripheralSourceEscape | null = null
      for (const direction of directions) {
        for (let step = 0; step < 8; step++) {
          const offset =
            (direction.x ? obstacle.width : obstacle.height) / 2 +
            d / 2 +
            c +
            1e-5 +
            step * w
          const candidate = makeEscape(connection, [
            source,
            {
              x: source.x + direction.x * offset,
              y: source.y + direction.y * offset,
            },
          ])
          if (clears(candidate, fixed)) {
            additional = candidate
            break
          }
        }
        if (additional) break
      }
      if (!additional) return null
      fixed.push(additional)
    }
  remaining = remainingBuses()
  const geometryRules = rules()
  const initial = matchComponentDogboneViaSites(remaining, geometryRules)
  if (!initial) return null
  yield
  const matched = matchAngularlyOrderedLocalVias({
    buses: remaining,
    busId: bus.busId,
    rules: { ...geometryRules, preferredViaPointsByConnectionIndex: initial },
  })
  if (!matched) return null
  const sourceEscapes = [
    ...fixed,
    ...remaining.flatMap((owner) =>
      owner.connections.map((connection) =>
        makeEscape(connection, [
          connection.sourcePoint,
          matched.get(connection.connectionIndex)!,
        ]),
      ),
    ),
  ]
  if (sourceEscapes.some((escape) => !clears(escape, sourceEscapes)))
    return null
  const viaPointsByConnectionIndex = new Map(
    sourceEscapes.map((escape) => [escape.connectionIndex, escape.via.center]),
  )
  return {
    sourceEscapes,
    viaPointsByConnectionIndex,
    remoteConnectionIndices,
    localBus: remaining.find((b) => b.busId === bus.busId)!,
    sourceBoundary,
  }
}
