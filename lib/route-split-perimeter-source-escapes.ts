import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  segmentsAreClear,
} from "./geometry"
import { getViaSpanLayers } from "./layer-names"
import {
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaSites,
  type DogboneViaSiteGeometryRules,
} from "./match-component-dogbone-via-sites"
import { routeSingleLayerWithAdaptiveExitsSteps } from "./route-single-layer-adaptive-exits"
import type {
  PeripheralSourceEscape,
  PeripheralSourceEscapeParams,
} from "./route-peripheral-source-escapes"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
} from "./types"

const EPS = 1e-7
export interface SplitPerimeterSources {
  sourceEscapes: PeripheralSourceEscape[]
  sourceBoundary: Bounds
  remoteConnectionIndices: Set<number>
  bottomRemoteConnectionIndices: Set<number>
  lowerConnectionIndices: number[]
  viaPointsByConnectionIndex: Map<number, Point2D>
}

export function chamferSplitPerimeter(
  points: readonly Point2D[],
  width: number,
): Point2D[] {
  const ps = points.filter((p, i) => !i || distance(p, points[i - 1]!) > 1e-9)
  return ps.flatMap((p, i) => {
    if (!i || i === ps.length - 1) return [p]
    const a = ps[i - 1]!,
      b = ps[i + 1]!,
      A = distance(a, p),
      B = distance(p, b)
    if (Math.abs((p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y)) > 1e-9)
      return [p]
    const k = Math.min(width, A / 3, B / 3)
    return [
      { x: p.x + ((a.x - p.x) * k) / A, y: p.y + ((a.y - p.y) * k) / A },
      { x: p.x + ((b.x - p.x) * k) / B, y: p.y + ((b.y - p.y) * k) / B },
    ]
  })
}

/** Preserve ordinary via domains while choosing an ordered peripheral subset. */
function orderedPhysicalSubset(
  paths: FanoutRoutePlan[],
  params: PeripheralSourceEscapeParams,
  center: Point2D,
): FanoutRoutePlan[] | null {
  if (paths.length > 28) return null
  const { traceWidth: w, clearance: c, viaDiameter: d } = params
  const all = params.buses.flatMap((b) => b.connections)
  const candidates = getComponentDogboneViaSiteCandidates(params.buses, {
    ...params,
    additionalObstacles: params.srj.obstacles,
  })
  const own = new Map(paths.map((p, i) => [p.connectionIndex, i]))
  const domains = all.map((connection) => ({
    own: own.get(connection.connectionIndex),
    masks: candidates
      .filter((v) => v.connectionIndex === connection.connectionIndex)
      .map((v) => {
        const s = {
          start: connection.sourcePoint,
          end: v.point,
          width: w,
          layer: connection.sourceLayer,
        }
        let mask = 0
        paths.forEach((p, i) => {
          if (p.connectionIndex === connection.connectionIndex) return
          if (
            distance(v.point, p.exitPoint) < d + c - EPS ||
            distancePointToSegment(p.exitPoint, s.start, s.end) <
              d / 2 + w / 2 + c - EPS ||
            p.segments.some(
              (t) =>
                distancePointToSegment(v.point, t.start, t.end) <
                  d / 2 + w / 2 + c - EPS || !segmentsAreClear(s, t, c),
            )
          )
            mask |= 1 << i
        })
        return mask
      }),
  }))
  const angle = (p: Point2D) => Math.atan2(p.y - center.y, p.x - center.x)
  const physical = paths
    .map((_, i) => i)
    .sort((a, b) => angle(paths[b]!.exitPoint) - angle(paths[a]!.exitPoint))
  const targets = params.bus.connections.toSorted(
    (a, b) =>
      angle(b.exitTargetPoint ?? b.targetPoint) -
      angle(a.exitTargetPoint ?? a.targetPoint),
  )
  const ranks = new Map(targets.map((c, i) => [c.connectionIndex, i]))
  const feasible = (mask: number) =>
    domains.every(
      (row) =>
        (row.own !== undefined && mask & (1 << row.own)) ||
        row.masks.some((blocked) => !(blocked & mask)),
    )
  let best: number[] = []
  let work = 0
  for (let offset = 0; offset < paths.length; offset++) {
    const sequence = [...physical.slice(offset), ...physical.slice(0, offset)]
    const visit = (
      at: number,
      last: number,
      mask: number,
      selected: number[],
    ) => {
      if (
        ++work > 1_000_000 ||
        selected.length + sequence.length - at < best.length
      )
        return
      if (at === sequence.length) {
        if (selected.length > best.length && feasible(mask))
          best = [...selected]
        return
      }
      const i = sequence[at]!,
        rank = ranks.get(paths[i]!.connectionIndex)!
      if (rank > last) visit(at + 1, rank, mask | (1 << i), [...selected, i])
      visit(at + 1, last, mask, selected)
    }
    visit(0, -1, 0, [])
  }
  return best.length >= 3 ? best.map((i) => paths[i]!) : null
}

/** A source-layer split allows a reversed lower group to use the opposite perimeter. */
export function* routeSplitPerimeterSourceEscapesSteps(
  params: PeripheralSourceEscapeParams,
): Generator<void, SplitPerimeterSources | null, unknown> {
  const { bus, srj, traceWidth: w, clearance: c, viaDiameter: d } = params
  if (
    bus.termination.type !== "boundary" ||
    bus.exitEdge !== "left" ||
    bus.connections.length < 8 ||
    bus.connections.length > 28 ||
    params.targetLayer === "top" ||
    bus.connections.some((c) => c.sourceLayer !== "top")
  )
    return null
  const padPitch = Math.min(bus.pitchX, bus.pitchY),
    pitch = w + c
  if (!Number.isFinite(padPitch) || padPitch <= 0) return null
  const os = bus.componentObstacles.filter((o) => o.layers.includes("top"))
  const bounds = {
    minX: Math.min(...os.map((o) => o.center.x - o.width / 2)),
    maxX: Math.max(...os.map((o) => o.center.x + o.width / 2)),
    minY: Math.min(...os.map((o) => o.center.y - o.height / 2)),
    maxY: Math.max(...os.map((o) => o.center.y + o.height / 2)),
  }
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  }
  const halfX =
      Math.ceil(((bounds.maxX - bounds.minX) / 2 + padPitch + pitch) / pitch) *
      pitch,
    halfY =
      Math.ceil(((bounds.maxY - bounds.minY) / 2 + padPitch + pitch) / pitch) *
      pitch
  const sourceBoundary = {
    minX: center.x - halfX,
    maxX: center.x + halfX,
    minY: center.y - halfY,
    maxY: center.y + halfY,
  }
  if (
    sourceBoundary.minX <= bus.sharedBoundary.minX ||
    sourceBoundary.maxY >= bus.sharedBoundary.maxY ||
    sourceBoundary.minY <= bus.sharedBoundary.minY
  )
    return null
  const byIndex = new Map(
    params.buses.flatMap((owner) =>
      owner.connections.map(
        (connection) =>
          [connection.connectionIndex, { owner, connection }] as const,
      ),
    ),
  )
  const target = (connection: PreparedConnection) =>
    params.targetPointsByConnectionIndex?.get(connection.connectionIndex) ?? {
      x: bus.sharedBoundary.minX,
      y: (connection.exitTargetPoint ?? connection.targetPoint).y,
    }
  const singleton = (connections: PreparedConnection[]) =>
    connections.map((connection, i) => ({
      ...bus,
      busId: `${bus.busId}:split-source:${i}`,
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
    buses: singleton(bus.connections),
    traceWidth: w,
    clearance: c,
  })
  if (!paths || paths.length !== bus.connections.length) return null
  const selected = orderedPhysicalSubset(paths, params, center)
  if (!selected) return null
  const make = (
    connection: PreparedConnection,
    ps: Point2D[],
  ): PeripheralSourceEscape => {
    const owner = byIndex.get(connection.connectionIndex)!.owner
    const toLayer =
      owner === bus
        ? params.targetLayer
        : owner.termination.type === "plane"
          ? owner.termination.layer
          : (params.targetLayerByBusId?.get(owner.busId) ??
            (owner.allowedLayers ?? params.layerNames).find(
              (l) => l !== connection.sourceLayer,
            ))
    if (!toLayer)
      throw Error("FanoutSolver: split source has no legal target layer")
    return {
      connectionIndex: connection.connectionIndex,
      connectionName: connection.connection.name,
      segments: ps.slice(1).map((end, i) => ({
        start: ps[i]!,
        end,
        width: w,
        layer: connection.sourceLayer,
      })),
      via: {
        center: ps.at(-1)!,
        diameter: d,
        holeDiameter: params.viaHoleDiameter,
        fromLayer: connection.sourceLayer,
        toLayer,
        spanLayers: getViaSpanLayers({
          fromLayer: connection.sourceLayer,
          toLayer,
          layerNames: params.layerNames,
          allowBlindAndBuriedVias: false,
        }),
      },
    }
  }
  const clear = (
    p: PeripheralSourceEscape,
    others: readonly PeripheralSourceEscape[],
  ) => {
    const conn = byIndex.get(p.connectionIndex)!.connection
    if (
      p.segments.some((s) =>
        [s.start, s.end].some(
          (q) =>
            q.x < bus.sharedBoundary.minX - EPS ||
            q.x > bus.sharedBoundary.maxX + EPS ||
            q.y < bus.sharedBoundary.minY - EPS ||
            q.y > bus.sharedBoundary.maxY + EPS,
        ),
      )
    )
      return false
    for (const o of srj.obstacles) {
      if (
        o.layers.some((l) => p.via.spanLayers.includes(l)) &&
        distancePointToObstacle(p.via.center, o) < d / 2 + c - EPS
      )
        return false
      if (
        o !== conn.sourceObstacle &&
        p.segments.some(
          (s) =>
            o.layers.includes(s.layer) &&
            distanceSegmentToObstacle(s, o) < w / 2 + c - EPS,
        )
      )
        return false
    }
    return others.every(
      (q) =>
        q.connectionIndex === p.connectionIndex ||
        (distance(p.via.center, q.via.center) >= d + c - EPS &&
          p.segments.every(
            (s) =>
              distancePointToSegment(q.via.center, s.start, s.end) >=
                d / 2 + w / 2 + c - EPS &&
              q.segments.every((t) => segmentsAreClear(s, t, c)),
          ) &&
          q.segments.every(
            (s) =>
              distancePointToSegment(p.via.center, s.start, s.end) >=
              d / 2 + w / 2 + c - EPS,
          )),
    )
  }
  const remaining = (fixed: PeripheralSourceEscape[]) => {
    const ids = new Set(fixed.map((p) => p.connectionIndex))
    return params.buses
      .map((b) => ({
        ...b,
        connections: b.connections.filter((c) => !ids.has(c.connectionIndex)),
      }))
      .filter((b) => b.connections.length)
  }
  let preferred = params.initialViaPoints
  const rules = (
    fixed: PeripheralSourceEscape[],
  ): DogboneViaSiteGeometryRules => ({
    ...params,
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
    preferredViaPointsByConnectionIndex: preferred,
  })
  const rawFixed = selected.map((p) =>
    make(byIndex.get(p.connectionIndex)!.connection, [
      p.segments[0]!.start,
      ...p.segments.map((s) => s.end),
    ]),
  )
  const initial = matchComponentDogboneViaSites(
    remaining(rawFixed),
    rules(rawFixed),
  )
  if (!initial) return null
  preferred = new Map([
    ...initial,
    ...rawFixed.map((p) => [p.connectionIndex, p.via.center] as const),
  ])
  // Unwrap the cyclic subset into the increasing order of this straight edge.
  const byTarget = selected.toSorted(
    (a, b) =>
      target(byIndex.get(a.connectionIndex)!.connection).y -
      target(byIndex.get(b.connectionIndex)!.connection).y,
  )
  let unwrapped: FanoutRoutePlan[] = []
  for (const p of byTarget) {
    const suffix = [p]
    let last = p.exitPoint.x
    for (const q of byTarget.slice(byTarget.indexOf(p) + 1))
      if (q.exitPoint.x > last + pitch - EPS) {
        suffix.push(q)
        last = q.exitPoint.x
      }
    if (suffix.length > unwrapped.length) unwrapped = suffix
  }
  if (unwrapped.length < 3) return null
  const sourcePoints = new Map(
    unwrapped.map((p) => [
      p.connectionIndex,
      [p.segments[0]!.start, ...p.segments.map((s) => s.end)],
    ]),
  )
  const viaX = bus.sharedBoundary.minX + Math.max(padPitch / 2, d / 2 + c),
    roof = sourceBoundary.maxY + padPitch - pitch / 2,
    side = sourceBoundary.minX - padPitch + pitch / 2
  const extend = () =>
    [...sourcePoints]
      .sort(
        ([a], [b]) =>
          target(byIndex.get(a)!.connection).y -
          target(byIndex.get(b)!.connection).y,
      )
      .map(([id, ps], i) => {
        const end = target(byIndex.get(id)!.connection),
          port = ps.at(-1)!
        return make(
          byIndex.get(id)!.connection,
          chamferSplitPerimeter(
            [
              ...ps,
              { x: port.x, y: roof + i * pitch },
              { x: side - i * pitch, y: roof + i * pitch },
              { x: side - i * pitch, y: end.y },
              { x: viaX, y: end.y },
            ],
            w,
          ),
        )
      })
  let fixed = extend()
  if (fixed.some((p) => !clear(p, fixed))) return null
  // A local corner followed by a straight top escape can fill an unused ordered port.
  for (const conn of bus.connections.toSorted(
    (a, b) => target(a).y - target(b).y,
  )) {
    if (sourcePoints.has(conn.connectionIndex)) continue
    const before =
      [...sourcePoints]
        .filter(
          ([id]) => target(byIndex.get(id)!.connection).y < target(conn).y,
        )
        .at(-1)?.[1]
        .at(-1)?.x ?? sourceBoundary.minX
    const after =
      [...sourcePoints]
        .filter(
          ([id]) => target(byIndex.get(id)!.connection).y > target(conn).y,
        )[0]?.[1]
        .at(-1)?.x ?? sourceBoundary.maxX
    for (const sx of [-1, 1]) {
      const point = {
        x: conn.sourcePoint.x + (sx * padPitch) / 2,
        y: conn.sourcePoint.y + padPitch / 2,
      }
      if (point.x < before + pitch - EPS || point.x > after - pitch + EPS)
        continue
      const ps = [
        conn.sourcePoint,
        point,
        { x: point.x, y: sourceBoundary.maxY },
      ]
      sourcePoints.set(conn.connectionIndex, ps)
      const attempt = extend()
      if (
        attempt.every((p) => clear(p, attempt)) &&
        matchComponentDogboneViaSites(remaining(attempt), rules(attempt))
      ) {
        fixed = attempt
        break
      }
      sourcePoints.delete(conn.connectionIndex)
    }
  }
  const firstTarget = Math.min(
    ...fixed.map((p) => target(byIndex.get(p.connectionIndex)!.connection).y),
  )
  for (const p of paths
    .filter(
      (p) =>
        Math.abs(p.exitPoint.x - sourceBoundary.minX) < EPS &&
        target(byIndex.get(p.connectionIndex)!.connection).y < firstTarget,
    )
    .sort(
      (a, b) =>
        target(byIndex.get(b.connectionIndex)!.connection).y -
        target(byIndex.get(a.connectionIndex)!.connection).y,
    )) {
    const conn = byIndex.get(p.connectionIndex)!.connection,
      end = target(conn),
      column = sourceBoundary.minX - pitch,
      attempt = make(
        conn,
        chamferSplitPerimeter(
          [
            p.segments[0]!.start,
            ...p.segments.map((s) => s.end),
            { x: column, y: p.exitPoint.y },
            { x: column, y: end.y },
            { x: viaX, y: end.y },
          ],
          w,
        ),
      )
    if (
      clear(attempt, fixed) &&
      matchComponentDogboneViaSites(
        remaining([...fixed, attempt]),
        rules([...fixed, attempt]),
      )
    )
      fixed.push(attempt)
  }
  const remoteConnectionIndices = new Set(fixed.map((p) => p.connectionIndex)),
    locals = bus.connections
      .filter((c) => !remoteConnectionIndices.has(c.connectionIndex))
      .sort((a, b) => target(a).y - target(b).y)
  // The lower triad is routed as an outer separator, a source-layer escape,
  // and an inner lower lane. Other topologies retain the general fallback.
  if (locals.length < 5) return null
  const lower = locals.slice(0, 3),
    bottomConnection = lower[1]!,
    innerLower = lower[2]!
  const obstacles = [
    ...srj.obstacles,
    ...fixed.flatMap((p) =>
      p.segments.map((s) => ({
        type: "rect" as const,
        center: { x: (s.start.x + s.end.x) / 2, y: (s.start.y + s.end.y) / 2 },
        width: distance(s.start, s.end),
        height: s.width,
        ccwRotationDegrees:
          (Math.atan2(s.end.y - s.start.y, s.end.x - s.start.x) * 180) /
          Math.PI,
        layers: [s.layer],
        connectedTo: [p.connectionName],
      })),
    ),
  ]
  const bottomPaths = yield* routeSingleLayerWithAdaptiveExitsSteps({
    srj: { ...srj, obstacles },
    buses: singleton([bottomConnection, innerLower]),
    traceWidth: w,
    clearance: c,
    availableBoundaryRegions: [
      { direction: "down", preferredExit: "bottom", exitEdge: "bottom" },
    ],
  })
  if (!bottomPaths?.length) return null
  const bp = bottomPaths.find(
      (p) => p.connectionIndex === bottomConnection.connectionIndex,
    )!,
    bottom = make(bottomConnection, [
      bp.segments[0]!.start,
      ...bp.segments.map((s) => s.end),
    ])
  if (!clear(bottom, fixed)) return null
  fixed.push(bottom)
  remoteConnectionIndices.add(bottom.connectionIndex)
  const rem = remaining(fixed),
    fixedLower = new Map([
      [
        innerLower.connectionIndex,
        {
          x: innerLower.sourcePoint.x - padPitch / 2,
          y: innerLower.sourcePoint.y - padPitch / 2,
        },
      ],
    ])
  const matched = matchComponentDogboneViaSites(rem, {
    ...rules(fixed),
    fixedViaPointsByConnectionIndex: fixedLower,
  })
  if (!matched) return null
  const sourceEscapes = [
    ...fixed,
    ...rem.flatMap((b) =>
      b.connections.map((conn) =>
        make(conn, [conn.sourcePoint, matched.get(conn.connectionIndex)!]),
      ),
    ),
  ]
  if (sourceEscapes.some((p) => !clear(p, sourceEscapes))) return null
  return {
    sourceEscapes,
    sourceBoundary,
    remoteConnectionIndices,
    bottomRemoteConnectionIndices: new Set([bottom.connectionIndex]),
    lowerConnectionIndices: lower.map((c) => c.connectionIndex),
    viaPointsByConnectionIndex: new Map(
      sourceEscapes.map((p) => [p.connectionIndex, p.via.center]),
    ),
  }
}
