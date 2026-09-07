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
  type DogboneViaSiteGeometryRules,
  getComponentDogboneViaSiteCandidates,
} from "./match-component-dogbone-via-sites"
import { matchSourceViaSites as matchComponentDogboneViaSites } from "./match-source-via-sites"
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
    const a = points[i - 1]!
    const p = points[i]!
    const b = points[i + 1]!
    const dx = p.x - a.x
    const dy = p.y - a.y
    const ex = b.x - p.x
    const ey = b.y - p.y
    const before = Math.hypot(dx, dy)
    const after = Math.hypot(ex, ey)
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
  params: PeripheralSourceEscapeParams,
): FanoutRoutePlan[] {
  if (paths.length > 30) return []
  const byIndex = new Map(
    params.buses
      .flatMap((b) => b.connections)
      .map((c) => [c.connectionIndex, c]),
  )
  const candidates = getComponentDogboneViaSiteCandidates(params.buses, {
    ...params,
    additionalObstacles: params.srj.obstacles,
  })
  const own = new Map(paths.map((p, i) => [p.connectionIndex, i]))
  const domains = [...byIndex.values()].map((connection) => ({
    own: own.get(connection.connectionIndex),
    masks: candidates
      .filter((v) => v.connectionIndex === connection.connectionIndex)
      .map((v) => {
        const sourceSegment = {
          start: connection.sourcePoint,
          end: v.point,
          width: params.traceWidth,
          layer: connection.sourceLayer,
        }
        let mask = 0
        paths.forEach((p, i) => {
          if (p.connectionIndex === connection.connectionIndex) return
          if (
            p.segments.some(
              (t) =>
                distancePointToSegment(v.point, t.start, t.end) <
                  params.viaDiameter / 2 +
                    params.traceWidth / 2 +
                    params.clearance -
                    EPSILON ||
                !segmentsAreClear(sourceSegment, t, params.clearance),
            )
          )
            mask |= 1 << i
        })
        return mask
      }),
  }))
  const feasible = (mask: number) =>
    domains.every(
      (row) =>
        (row.own !== undefined && mask & (1 << row.own)) ||
        row.masks.some((blocked) => !(blocked & mask)),
    )
  const ordered = paths
    .map((_, i) => i)
    .sort(
      (a, b) =>
        Math.atan2(
          paths[a]!.exitPoint.y - center.y,
          paths[a]!.exitPoint.x - center.x,
        ) -
        Math.atan2(
          paths[b]!.exitPoint.y - center.y,
          paths[b]!.exitPoint.x - center.x,
        ),
    )
  let best: number[] = []
  let work = 0
  let exactCalls = 0
  const exact = (mask: number) => {
    if (++exactCalls > 80) return false
    const chosen = paths.filter((_, i) => mask & (1 << i))
    const ids = new Set(chosen.map((p) => p.connectionIndex))
    const buses = params.buses
      .map((b) => ({
        ...b,
        connections: b.connections.filter((c) => !ids.has(c.connectionIndex)),
      }))
      .filter((b) => b.connections.length)
    return Boolean(
      matchComponentDogboneViaSites(buses, {
        ...params,
        additionalObstacles: params.srj.obstacles,
        maximumSearchStates: 100000,
        blockingSegments: chosen.flatMap((p) =>
          p.segments.map((segment) => ({
            connectionIndex: p.connectionIndex,
            segment,
          })),
        ),
        blockingVias: chosen.map((p) => ({
          connectionIndex: p.connectionIndex,
          center: p.exitPoint,
          diameter: params.viaDiameter,
          spanLayers: params.layerNames,
        })),
      }),
    )
  }
  const visit = (
    at: number,
    last: number,
    mask: number,
    selected: number[],
  ) => {
    if (++work > 200000 || selected.length + ordered.length - at < best.length)
      return
    if (at === ordered.length) {
      if (selected.length > best.length && feasible(mask) && exact(mask))
        best = [...selected]
      return
    }
    const i = ordered[at]!
    const rank = ranks.get(paths[i]!.connectionIndex)!
    if (rank > last) visit(at + 1, rank, mask | (1 << i), [...selected, i])
    visit(at + 1, last, mask, selected)
  }
  visit(0, -1, 0, [])

  return best.map((i) => paths[i]!)
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
  const pitch = w + c
  const padPitch = Math.max(bus.pitchX, bus.pitchY)
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
  const selected = selectOrderedPaths(
    paths.filter(
      (p) =>
        Math.abs(p.exitPoint.y - sourceBoundary.maxY) <= EPSILON ||
        (Math.abs(p.exitPoint.x - sourceBoundary.minX) <= EPSILON &&
          p.exitPoint.y >= center.y),
    ),
    ranks,
    center,
    params,
  )

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
  let sideLane = 0
  const fixed: PeripheralSourceEscape[] = selected.map((path, i) => {
    const connection = byIndex.get(path.connectionIndex)!.connection
    const exit = target(connection)
    const height = firstHeight + i * pitch
    const column = firstColumn + i * pitch
    const sideColumn =
      Math.abs(path.exitPoint.x - sourceBoundary.minX) <= EPSILON
        ? sourceBoundary.minX - ++sideLane * pitch
        : path.exitPoint.x
    return makeEscape(
      connection,
      chamfer(
        [
          path.segments[0]!.start,
          ...path.segments.map((s) => s.end),
          { x: sideColumn, y: path.exitPoint.y },
          { x: sideColumn, y: height },
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
    sourceEscape: PeripheralSourceEscape,
    others: readonly PeripheralSourceEscape[],
  ) => {
    const connection = byIndex.get(sourceEscape.connectionIndex)!.connection
    if (
      sourceEscape.segments.some((segment) =>
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
          sourceEscape.via.spanLayers.includes(layer),
        ) &&
        distancePointToObstacle(sourceEscape.via.center, obstacle) <
          d / 2 + c - EPSILON
      )
        return false
      if (
        obstacle !== connection.sourceObstacle &&
        sourceEscape.segments.some(
          (segment) =>
            obstacle.layers.includes(segment.layer) &&
            distanceSegmentToObstacle(segment, obstacle) < w / 2 + c - EPSILON,
        )
      )
        return false
    }
    for (const other of others) {
      if (sourceEscape.connectionIndex === other.connectionIndex) continue
      if (distance(sourceEscape.via.center, other.via.center) < d + c - EPSILON)
        return false
      if (
        sourceEscape.segments.some(
          (s) =>
            distancePointToSegment(other.via.center, s.start, s.end) <
            viaTraceDistance - EPSILON,
        ) ||
        other.segments.some(
          (s) =>
            distancePointToSegment(sourceEscape.via.center, s.start, s.end) <
            viaTraceDistance - EPSILON,
        )
      )
        return false
      if (
        sourceEscape.segments.some((a) =>
          other.segments.some((b) => !segmentsAreClear(a, b, c)),
        )
      )
        return false
    }
    return true
  }
  if (fixed.some((sourceEscape) => !clears(sourceEscape, fixed))) return null
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
      if (owner.termination.type !== "plane") {
        return null
      }
      const source = connection.sourcePoint
      const obstacle = connection.sourceObstacle
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
      if (!additional) {
        return null
      }
      fixed.push(additional)
    }
  remaining = remainingBuses()
  const geometryRules = rules()
  const initial = matchComponentDogboneViaSites(remaining, geometryRules)
  if (!initial) return null
  yield
  const angular = matchAngularlyOrderedLocalVias({
    buses: remaining,
    busId: bus.busId,
    rules: { ...geometryRules, preferredViaPointsByConnectionIndex: initial },
  })

  const matched = angular ?? initial
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
  if (
    sourceEscapes.some((sourceEscape) => !clears(sourceEscape, sourceEscapes))
  )
    return null
  const viaPointsByConnectionIndex = new Map(
    sourceEscapes.map((sourceEscape) => [
      sourceEscape.connectionIndex,
      sourceEscape.via.center,
    ]),
  )
  return {
    sourceEscapes,
    viaPointsByConnectionIndex,
    remoteConnectionIndices,
    localBus: remaining.find((b) => b.busId === bus.busId)!,
    sourceBoundary,
  }
}
