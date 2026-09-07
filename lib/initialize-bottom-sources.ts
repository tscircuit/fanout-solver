import { distance, distanceSegmentToSegment } from "./geometry"
import { getComponentDogboneViaSiteCandidates } from "./match-component-dogbone-via-sites"
import { matchSourceViaSites as matchComponentDogboneViaSites } from "./match-source-via-sites"
import { fanoutPlansAreClear, type RouteBusParams } from "./route-bus"
import { routePeripheralSourceEscapesSteps } from "./route-feasible-peripheral-sources"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import { chamferSplitPerimeter } from "./route-split-perimeter-source-escapes"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type { Bounds, FanoutRoutePlan, Point2D, PreparedBus } from "./types"
export interface BottomSourceInitialization {
  sourceEscapes: PeripheralSourceEscape[]
  viaPointsByConnectionIndex: Map<number, Point2D>
  remoteConnectionIndices: Set<number>
  sourceBoundary: Bounds
  promotionLog: Array<{ connectionIndex: number; family: string; via: Point2D }>
  checks: number
  successes: number
  plans: FanoutRoutePlan[]
  evaluation: { score: number; priority: number[] } | null
}
export interface InitializeBottomSourcesParams
  extends Omit<RouteBusParams, "acceptedPlans"> {
  buses: PreparedBus[]
  targetLayerByBusId: ReadonlyMap<string, string>
  maximumPromotions?: number
  maximumCandidateChecks?: number
  promotionPolicy?: "outside-first" | "inversion-first" | "outer-top-first"
  shortenSeed?: boolean
  allowOuterWraps?: boolean
  evaluateSourceState?: (
    sources: PeripheralSourceEscape[],
    plans: FanoutRoutePlan[],
  ) => Generator<unknown, { score: number; priority: number[] }>
}
export function* initializeBottomSourcesSteps(
  params: InitializeBottomSourcesParams,
): Generator<unknown, BottomSourceInitialization | null> {
  const { bus, traceWidth: w, clearance: c, viaDiameter: d } = params
  if (bus.exitEdge !== "bottom") return null
  for (const value of [
    params.maximumPromotions ?? bus.connections.length,
    params.maximumCandidateChecks ?? 128,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(
        "Source initialization requires finite non-negative search budgets",
      )
  const proxy = {
    ...bus,
    direction: "right" as const,
    exitEdge: "right" as const,
    preferredExit: "right" as const,
    connections: bus.connections.map((q) => ({
      ...q,
      exitTargetPoint: {
        x: bus.sharedBoundary.maxX,
        y: (q.exitTargetPoint ?? q.targetPoint).x,
        layer: params.targetLayer,
      },
    })),
  }
  const seed = yield* routePeripheralSourceEscapesSteps({
    ...params,
    bus: proxy,
    buses: params.buses.map((b) => (b.busId === bus.busId ? proxy : b)),
  })
  if (!seed) return null
  const byIndex = new Map(
    params.buses.flatMap((b) =>
      b.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus: b, connection }] as const,
      ),
    ),
  )
  const originalNative = getComponentDogboneViaSiteCandidates(params.buses, {
    ...params,
    additionalObstacles: params.srj.obstacles,
  })
  const nativeById = new Map(
    params.buses.flatMap((b) =>
      b.connections.map(
        (q) =>
          [
            q.connectionIndex,
            originalNative
              .filter((s) => s.connectionIndex === q.connectionIndex)
              .map((s) => s.point),
          ] as const,
      ),
    ),
  )
  const remote = new Set(seed.remoteConnectionIndices)
  const pitch = w + c
  const viaPitch = d + c + 1e-5
  const sb = seed.sourceBoundary
  const sourceLength = (s: PeripheralSourceEscape) =>
    s.segments.reduce((n, p) => n + distance(p.start, p.end), 0)
  const copy = (source: PeripheralSourceEscape, points: Point2D[]) => {
    const ps = chamferSplitPerimeter(points, w)
    return {
      ...source,
      segments: ps.slice(1).map((end, i) => ({
        start: ps[i]!,
        end,
        layer: byIndex.get(source.connectionIndex)!.connection.sourceLayer,
        width: w,
      })),
      via: { ...source.via, center: ps.at(-1)! },
    }
  }
  const plansOf = (escapes: PeripheralSourceEscape[]) =>
    escapes.map((e) => {
      const h = byIndex.get(e.connectionIndex)!
      const p = buildViaMinimalWindingPlan({
        ...params,
        allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
        bus: h.bus,
        targetLayer: e.via.toLayer,
        terminal: {
          connection: h.connection,
          viaPoint: e.via.center,
          exitPoint: e.via.center,
        },
        sourceEscapePoints: [
          e.segments[0]!.start,
          ...e.segments.map((s) => s.end),
        ],
        targetLayerPoints: [e.via.center, e.via.center],
      })
      p.termination = { type: "plane", layer: e.via.toLayer }
      p.sourceEscapeSegmentCount = e.segments.length
      return p
    })
  const clear = (escapes: PeripheralSourceEscape[]) =>
    escapes.every(sourcePathIsValid) &&
    fanoutPlansAreClear({
      ...params,
      plans: plansOf(escapes),
      sharedBoundary: bus.sharedBoundary,
    })
  const held = new Map(
    seed.sourceEscapes
      .filter(
        (e) =>
          remote.has(e.connectionIndex) ||
          !(nativeById.get(e.connectionIndex) ?? []).some(
            (p) => distance(p, e.via.center) < 1e-7,
          ),
      )
      .map((e) => [e.connectionIndex, e]),
  )
  const seedOrder = seed.sourceEscapes
    .filter((e) => remote.has(e.connectionIndex))
    .sort((a, b) => a.via.center.y - b.via.center.y)
  for (const [i, e] of seedOrder.entries()) {
    const tail = e.segments.at(-3)!
    if (
      Math.abs(tail.start.x - tail.end.x) > 1e-7 ||
      tail.start.y <= tail.end.y
    )
      return null
    const y = sb.minY - d / 2 - w / 2 - c - 1e-5 - i * viaPitch
    const target = (
      byIndex.get(e.connectionIndex)!.connection.exitTargetPoint ??
      byIndex.get(e.connectionIndex)!.connection.targetPoint
    ).x
    const points = [
      e.segments[0]!.start,
      ...e.segments.slice(0, -3).map((s) => s.end),
      { x: tail.start.x, y: y + w },
      { x: tail.start.x - w, y },
      { x: target, y },
    ]
    held.set(e.connectionIndex, copy(e, points))
  }
  let sourceEscapes: PeripheralSourceEscape[] = seed.sourceEscapes
  let checks = 0
  let successes = 0
  const rematch = (next: Map<number, PeripheralSourceEscape>) => {
    if (!clear([...next.values()])) return null
    const remaining = params.buses
      .map((b) => ({
        ...b,
        connections: b.connections.filter((q) => !next.has(q.connectionIndex)),
      }))
      .filter((b) => b.connections.length)
    const fixed = [...next.values()]
    const matched = matchComponentDogboneViaSites(remaining, {
      ...params,
      maximumSearchStates: 30000,
      additionalObstacles: params.srj.obstacles,
      preferredViaPointsByConnectionIndex: new Map(
        sourceEscapes.map((e) => [e.connectionIndex, e.via.center]),
      ),
      blockingSegments: fixed.flatMap((e) =>
        e.segments.map((segment) => ({
          connectionIndex: e.connectionIndex,
          segment,
        })),
      ),
      blockingVias: fixed.map((e) => ({
        connectionIndex: e.connectionIndex,
        ...e.via,
      })),
    })
    if (!matched) return null
    const all = sourceEscapes.map(
      (e) =>
        next.get(e.connectionIndex) ??
        copy(e, [
          byIndex.get(e.connectionIndex)!.connection.sourcePoint,
          matched.get(e.connectionIndex)!,
        ]),
    )
    return clear(all) ? all : null
  }
  const initial = rematch(held)
  if (!initial) return null
  sourceEscapes = initial

  if (params.shortenSeed) {
    for (const seedSource of seedOrder) {
      const e = held.get(seedSource.connectionIndex)!
      const q = byIndex.get(e.connectionIndex)!.connection.sourcePoint
      const column = e.segments
        .filter(
          (s) =>
            s.start.x > bus.componentBounds.maxX &&
            Math.abs(s.start.x - s.end.x) < 1e-7 &&
            s.end.y < s.start.y,
        )
        .sort((a, b) => distance(b.start, b.end) - distance(a.start, a.end))[0]
        ?.start.x
      if (column === undefined) continue
      for (const corner of (nativeById.get(e.connectionIndex) ?? []).filter(
        (p) => p.x > q.x,
      )) {
        const replacement = copy(e, [
          q,
          corner,
          { x: column, y: corner.y },
          { x: column, y: e.via.center.y },
          e.via.center,
        ])
        if (sourceLength(replacement) >= sourceLength(e) - w) continue
        const next = new Map(held)
        next.set(e.connectionIndex, replacement)
        const matched = rematch(next)
        yield { phase: "shorten-seed", connectionIndex: e.connectionIndex }
        if (!matched) continue
        held.set(e.connectionIndex, replacement)
        sourceEscapes = matched

        break
      }
    }
  }

  const maxChecks = params.maximumCandidateChecks ?? 128
  const maximumPromotions = params.maximumPromotions ?? bus.connections.length
  function candidates(e: PeripheralSourceEscape) {
    const q = byIndex.get(e.connectionIndex)!.connection.sourcePoint
    const native = nativeById.get(e.connectionIndex) ?? []
    const target = (
      byIndex.get(e.connectionIndex)!.connection.exitTargetPoint ??
      byIndex.get(e.connectionIndex)!.connection.targetPoint
    ).x
    const margin = d / 2 + w / 2 + c + pitch / 32
    const inset = {
      minX: sb.minX + margin,
      maxX: sb.maxX - margin,
      minY: sb.minY + margin,
      maxY: sb.maxY - margin,
    }
    const rows = [sb.minY, sb.minY - viaPitch]
    const out: { source: PeripheralSourceEscape; family: string }[] = []
    for (const p of native) {
      const dx = Math.sign(p.x - q.x)
      const dy = Math.sign(p.y - q.y)
      if (dx)
        out.push({
          source: copy(e, [
            q,
            p,
            { x: dx < 0 ? inset.minX : inset.maxX, y: p.y },
          ]),
          family: dx < 0 ? "left-ray" : "right-ray",
        })
      if (dy > 0 && params.allowOuterWraps) {
        const bottom =
          Math.min(sb.minY, ...[...held.values()].map((s) => s.via.center.y)) -
          viaPitch
        for (const side of [-1, 1])
          for (const tier of [0, 1, 2]) {
            const column =
              (side < 0 ? sb.minX : sb.maxX) + side * (tier * viaPitch)
            const roof = sb.maxY + tier * pitch
            out.push({
              source: copy(e, [
                q,
                p,
                { x: p.x, y: roof },
                { x: column, y: roof },
                { x: column, y: bottom },
                { x: target, y: bottom },
              ]),
              family: side < 0 ? "upper-wrap-left" : "upper-wrap-right",
            })
          }
      }
      if (dy > 0) {
        out.push({
          source: copy(e, [q, p, { x: p.x, y: sb.maxY }]),
          family: "upper-ray",
        })
        for (const step of [-2, -1, 1, 2])
          if (Math.sign(step) === dx)
            out.push({
              source: copy(e, [
                q,
                p,
                { x: p.x + step * bus.pitchX, y: p.y },
                { x: p.x + step * bus.pitchX, y: sb.maxY },
              ]),
              family: "upper-elbow",
            })
      }
      if (dy < 0)
        for (const row of rows)
          for (const step of [0, -1, 1]) {
            const col = p.x + step * bus.pitchX
            if (step && Math.sign(step) !== dx) continue
            out.push({
              source: copy(e, [
                q,
                p,
                { x: col, y: p.y },
                { x: col, y: row },
                { x: target, y: row },
              ]),
              family: "bottom-ray",
            })
          }
    }
    const seen = new Set<string>()
    return out
      .filter((v) => {
        const key = JSON.stringify(v.source.segments)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort(
        (a, b) =>
          Number(
            b.family === "bottom-ray" || b.family.startsWith("upper-wrap"),
          ) -
            Number(
              a.family === "bottom-ray" || a.family.startsWith("upper-wrap"),
            ) || sourceLength(a.source) - sourceLength(b.source),
      )
  }
  const topPadCenter = Math.max(
    ...bus.componentObstacles
      .filter((o) => o.layers.includes("top"))
      .map((o) => o.center.y),
  )
  const promotionLog: BottomSourceInitialization["promotionLog"] = []
  let evaluation = params.evaluateSourceState
    ? yield* params.evaluateSourceState(sourceEscapes, plansOf(sourceEscapes))
    : null
  for (
    let round = 0;
    round < maximumPromotions && checks < maxChecks;
    round++
  ) {
    let accepted = false
    const pending = bus.connections
      .filter((q) => !held.has(q.connectionIndex))
      .sort((a, b) => {
        const nearest = (q: typeof a) =>
          Math.min(
            sb.maxY - q.sourcePoint.y,
            q.sourcePoint.x - sb.minX,
            sb.maxX - q.sourcePoint.x,
          )
        const inversion = (q: typeof a) =>
          bus.connections.filter(
            (p) =>
              !held.has(p.connectionIndex) &&
              (p.sourcePoint.x - q.sourcePoint.x) *
                ((p.exitTargetPoint ?? p.targetPoint).x -
                  (q.exitTargetPoint ?? q.targetPoint).x) <
                -1e-7,
          ).length
        const priority = (id: number) => evaluation?.priority.indexOf(id) ?? -1
        const priorityRank = (id: number) =>
          priority(id) < 0 ? bus.connections.length : priority(id)
        const top = (q: typeof a) => q.sourcePoint.y >= topPadCenter - 1e-7
        const topOrder =
          params.promotionPolicy === "outer-top-first"
            ? Number(top(b)) - Number(top(a)) ||
              (top(a) && top(b)
                ? (a.exitTargetPoint ?? a.targetPoint).x -
                  (b.exitTargetPoint ?? b.targetPoint).x
                : 0)
            : 0
        return (
          topOrder ||
          priorityRank(a.connectionIndex) - priorityRank(b.connectionIndex) ||
          (params.promotionPolicy === "inversion-first" ||
          params.promotionPolicy === "outer-top-first"
            ? inversion(b) - inversion(a)
            : 0) ||
          nearest(a) - nearest(b) ||
          a.connectionIndex - b.connectionIndex
        )
      })
    for (const q of pending) {
      const e = sourceEscapes.find(
        (e) => e.connectionIndex === q.connectionIndex,
      )!
      for (const candidate of candidates(e)) {
        if (checks++ >= maxChecks) break
        const next = new Map(held)
        next.set(q.connectionIndex, candidate.source)
        const matched = rematch(next)
        yield {
          checks,
          remote: remote.size,
          connectionIndex: q.connectionIndex,
          family: candidate.family,
        }
        if (!matched) continue
        const nextEvaluation = params.evaluateSourceState
          ? yield* params.evaluateSourceState(matched, plansOf(matched))
          : null
        if (
          nextEvaluation &&
          evaluation &&
          nextEvaluation.score < evaluation.score
        )
          continue
        evaluation = nextEvaluation
        held.set(q.connectionIndex, candidate.source)
        remote.add(q.connectionIndex)
        sourceEscapes = matched
        successes++
        promotionLog.push({
          connectionIndex: q.connectionIndex,
          family: candidate.family,
          via: candidate.source.via.center,
        })

        accepted = true
        break
      }
      if (accepted || checks >= maxChecks) break
    }
    if (!accepted) break
  }
  return {
    sourceEscapes,
    viaPointsByConnectionIndex: new Map(
      sourceEscapes.map((e) => [e.connectionIndex, e.via.center]),
    ),
    remoteConnectionIndices: remote,
    sourceBoundary: sb,
    evaluation,
    promotionLog,
    checks,
    successes,
    plans: plansOf(sourceEscapes),
  }
}

/** Reject bends and loops before submitting any candidate to the source CSP. */
function sourcePathIsValid(source: PeripheralSourceEscape): boolean {
  const segments = source.segments
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!
    const dx = s.end.x - s.start.x
    const dy = s.end.y - s.start.y
    const length = Math.hypot(dx, dy)
    if (
      length < 1e-9 ||
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ) > 1e-7
    )
      return false
    if (i) {
      const p = segments[i - 1]!
      const ex = p.end.x - p.start.x
      const ey = p.end.y - p.start.y
      if (
        distance(p.end, s.start) > 1e-7 ||
        (dx * ex + dy * ey) / (length * Math.hypot(ex, ey)) <
          Math.SQRT1_2 - 1e-7
      )
        return false
    }
    for (let j = 0; j < i - 1; j++)
      if (
        distanceSegmentToSegment(
          segments[j]!.start,
          segments[j]!.end,
          s.start,
          s.end,
        ) < 1e-8
      )
        return false
  }
  return (
    segments.length > 0 &&
    distance(segments.at(-1)!.end, source.via.center) < 1e-7
  )
}
