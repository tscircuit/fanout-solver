import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import { fanoutPlansAreClear } from "./route-bus"
import {
  buildViaMinimalWindingPlan,
  routeViaMinimalWindingAlternativesSteps,
  type RouteViaMinimalWindingParams,
  type RouteViaMinimalWindingProgress,
  type ViaMinimalWindingTerminal,
} from "./route-via-minimal-winding"
import {
  chamferSplitPerimeter,
  type SplitPerimeterSources,
} from "./route-split-perimeter-source-escapes"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"

export type SplitBusParams = SplitPerimeterSources & {
  srj: SimpleRouteJson
  bus: PreparedBus
  targetLayer: string
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  /** Rematch pending sources around a lower band before routing its upper lanes. */
  rematchPendingSources?: {
    connectionIndices: ReadonlySet<number>
    afterLowerStage: (plans: FanoutRoutePlan[]) => boolean
  }
}

/** Promote a blocked terminal in a bounded search over complete lane orders. */
function* routeOrderedStage(
  params: RouteViaMinimalWindingParams,
): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan[] | null, void> {
  type Attempt = { order: number[]; bias: -1 | 0 | 1; completed: number }
  const seen = new Set<string>(),
    prefixes = new Set<string>(),
    queue: Attempt[] = []
  let evaluations = 0,
    result: FanoutRoutePlan[] | null = null
  function* evaluate(
    order: number[],
    bias: -1 | 0 | 1,
  ): Generator<RouteViaMinimalWindingProgress, void, void> {
    const key = order.join(",") + ":" + bias
    if (seen.has(key) || evaluations >= 256) return
    seen.add(key)
    evaluations++
    let completed = 0
    const gen = routeViaMinimalWindingAlternativesSteps(
      {
        ...params,
        routeOrder: order,
        laneBias: bias,
        maximumRouteOrderAttempts: 1,
      },
      1,
      false,
    )
    let r = gen.next()
    while (!r.done) {
      completed = Math.max(completed, r.value.connectionIndex)
      yield r.value
      r = gen.next()
    }
    if (r.value.length) {
      result = r.value[0]!
      return
    }
    const prefix = order.slice(0, completed + 1).join(",") + ":" + bias
    if (!prefixes.has(prefix)) {
      prefixes.add(prefix)
      queue.push({ order, bias, completed })
    }
  }
  const indices = params.terminals.map((_, i) => i)
  const target = indices.toSorted(
    (a, b) =>
      params.terminals[a]!.exitPoint.x - params.terminals[b]!.exitPoint.x,
  )
  for (const bias of [0, 1, -1] as const) {
    yield* evaluate(target, bias)
    if (result) return result
    yield* evaluate(target.toReversed(), bias)
    if (result) return result
  }
  while (queue.length && evaluations < 256) {
    queue.sort((a, b) => b.completed - a.completed)
    const { order, bias, completed } = queue.shift()!
    if (queue.length > 256) queue.length = 256
    for (let at = completed - 1; at >= 0; at--) {
      const moved = [...order],
        [failed] = moved.splice(completed, 1)
      moved.splice(at, 0, failed!)
      yield* evaluate(moved, bias)
      if (result) return result
      const swapped = [...order]
      ;[swapped[completed], swapped[at]] = [swapped[at]!, swapped[completed]!]
      yield* evaluate(swapped, bias)
      if (result) return result
    }
  }
  return null
}

/** Route a lower separator and an ordered upper bundle around a source field. */
export function* routeSplitPerimeterBusSteps(
  params: SplitBusParams,
): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan[] | null, void> {
  const {
    bus,
    srj,
    sourceBoundary,
    sourceEscapes,
    remoteConnectionIndices,
    bottomRemoteConnectionIndices,
    lowerConnectionIndices,
    targetLayer,
    traceWidth: w,
    clearance: c,
  } = params
  if (
    bus.exitEdge !== "left" ||
    bus.termination.type !== "boundary" ||
    lowerConnectionIndices.length !== 3
  )
    return null
  const padPitch = Math.min(bus.pitchX, bus.pitchY),
    pitch = w + c,
    byIndex = new Map(sourceEscapes.map((p) => [p.connectionIndex, p]))
  const terminals: ViaMinimalWindingTerminal[] = bus.connections
    .map((connection) => ({
      connection,
      viaPoint: byIndex.get(connection.connectionIndex)!.via.center,
      exitPoint: {
        x: bus.sharedBoundary.minX,
        y: (connection.exitTargetPoint ?? connection.targetPoint).y,
      },
    }))
    .sort((a, b) => a.exitPoint.y - b.exitPoint.y)
  const byTerminal = new Map(
    terminals.map((t) => [t.connection.connectionIndex, t]),
  )
  const lower = lowerConnectionIndices.map((i) => byTerminal.get(i)!),
    lowerIds = new Set(lowerConnectionIndices)
  const upper = terminals.filter(
    (t) =>
      !lowerIds.has(t.connection.connectionIndex) &&
      !remoteConnectionIndices.has(t.connection.connectionIndex),
  )
  if (upper.length < 2 || lower.some((t) => !t)) return null
  const sourcePoints = new Map(
    sourceEscapes.map((p) => [
      p.connectionIndex,
      [p.segments[0]!.start, ...p.segments.map((s) => s.end)],
    ]),
  )
  const build = (terminal: ViaMinimalWindingTerminal, points: Point2D[]) =>
    buildViaMinimalWindingPlan({
      ...params,
      bus,
      terminal,
      targetLayerPoints: points,
      sourceEscapePoints: sourcePoints.get(terminal.connection.connectionIndex),
      allowBlindAndBuriedVias: false,
    })
  // A shifted exit can lie below the source field. Put every lower rail
  // below its own endpoint before nesting the neighboring turns around it.
  const lowerRoof = Math.min(
    sourceBoundary.minY - params.viaDiameter / 2 - w / 2 - c - 1e-5,
    ...lower.map(
      (terminal, rank) =>
        terminal.exitPoint.y + (lower.length - 1 - rank) * pitch - pitch - w,
    ),
  )
  const outer = (
    terminal: ViaMinimalWindingTerminal,
    points: Point2D[],
    up: boolean,
  ) => {
    const j = (up ? upper : lower).findIndex(
      (t) =>
        t.connection.connectionIndex === terminal.connection.connectionIndex,
    )
    const port = points.at(-1)!,
      roof = up
        ? sourceBoundary.maxY + padPitch - pitch / 2 + j * pitch
        : lowerRoof - (lower.length - 1 - j) * pitch
    const column =
      sourceBoundary.minX -
      params.viaDiameter / 2 -
      w / 2 -
      c -
      1e-5 -
      (up ? j : lower.length - 1 - j) * pitch
    const extra = chamferSplitPerimeter(
      [
        port,
        { x: port.x, y: roof },
        { x: column, y: roof },
        { x: column, y: terminal.exitPoint.y },
        terminal.exitPoint,
      ],
      w,
    )
    return build(terminal, [...points, ...extra.slice(1)])
  }
  const remote = terminals
    .filter((t) => remoteConnectionIndices.has(t.connection.connectionIndex))
    .map((t) =>
      bottomRemoteConnectionIndices.has(t.connection.connectionIndex)
        ? outer(t, [t.viaPoint], false)
        : build(t, [t.viaPoint, t.exitPoint]),
    )
  let deferPendingViaReservations = !!params.rematchPendingSources
  const make = (
    ts: ViaMinimalWindingTerminal[],
    acceptedPlans: FanoutRoutePlan[],
    up: boolean,
    ports: Point2D[],
    fullBoundary = false,
  ): RouteViaMinimalWindingParams => {
    const ids = new Set(ts.map((t) => t.connection.connectionIndex)),
      stageBus: PreparedBus = {
        ...bus,
        connections: ts.map((t) => t.connection),
        exitEdge: up ? "top" : "bottom",
        direction: up ? "up" : "down",
        preferredExit: undefined,
        sharedBoundary: fullBoundary
          ? bus.sharedBoundary
          : {
              ...bus.sharedBoundary,
              maxY: sourceBoundary.maxY,
              ...(!up ? { minY: sourceBoundary.minY } : {}),
            },
      }
    return {
      ...params,
      bus: stageBus,
      terminals: ts.map((t, i) => ({ ...t, exitPoint: ports[i]! })),
      acceptedPlans,
      reservedVias: sourceEscapes
        .filter(
          (p) =>
            !ids.has(p.connectionIndex) &&
            (!deferPendingViaReservations ||
              !params.rematchPendingSources?.connectionIndices.has(
                p.connectionIndex,
              )),
        )
        .map((p) => ({ connectionName: p.connectionName, via: p.via })),
      sourceEscapePaths: sourcePoints,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
      gridStepDivisor: 2,
      gridStep: pitch / 2,
      alignGridToPads: true,
      reserveTerminalExitPoints: true,
    }
  }
  const outerLower = lower[0]!,
    innerLower = lower.at(-1)!,
    firstUpper = upper[0]!,
    lowerSource = innerLower.connection.sourcePoint,
    column = lowerSource.x + padPitch
  // The separator goes below the first upper source, then between that source
  // group and the inner lower source before descending to the outer lower lane.
  const guides = [
    {
      x: firstUpper.connection.sourcePoint.x,
      y: firstUpper.connection.sourcePoint.y - padPitch,
    },
    { x: lowerSource.x - padPitch, y: lowerSource.y },
    { x: column, y: lowerSource.y },
  ]
  let separatorPoints: Point2D[] = [outerLower.viaPoint]
  for (const goal of guides) {
    const temporary = { ...outerLower, viaPoint: separatorPoints.at(-1)! },
      stage = make([temporary], remote, true, [goal], true)
    stage.bus = { ...stage.bus, exitEdge: "right", direction: "right" }
    stage.sourceEscapePaths = undefined
    const routed = yield* routeOrderedStage(stage)
    if (!routed) return null
    separatorPoints.push(
      ...routed[0]!.segments
        .filter((s) => s.layer === targetLayer)
        .map((s) => s.end),
    )
  }
  separatorPoints = chamferSplitPerimeter(
    [...separatorPoints, { x: column, y: sourceBoundary.minY }],
    w,
  )
  const separator = outer(outerLower, separatorPoints, false)
  const bottomVia = sourceEscapes.find((p) =>
    bottomRemoteConnectionIndices.has(p.connectionIndex),
  )!.via.center
  const bottomPort = { x: bottomVia.x - padPitch, y: sourceBoundary.minY }
  deferPendingViaReservations = false
  const innerResult = yield* routeOrderedStage(
    make([innerLower], [...remote, separator], false, [bottomPort]),
  )
  if (!innerResult) return null
  const ips = innerResult[0]!.segments.filter((s) => s.layer === targetLayer),
    inner = outer(innerLower, [ips[0]!.start, ...ips.map((s) => s.end)], false)
  if (params.rematchPendingSources) {
    if (
      !params.rematchPendingSources.afterLowerStage([
        ...remote,
        separator,
        inner,
      ])
    )
      return null
    for (const source of sourceEscapes) {
      sourcePoints.set(source.connectionIndex, [
        source.segments[0]!.start,
        ...source.segments.map((segment) => segment.end),
      ])
    }
  }
  const minPadX = Math.min(
      ...bus.componentObstacles.map((o) => o.center.x - o.width / 2),
    ),
    far = minPadX + params.viaDiameter / 2
  const near =
    Math.max(...upper.map((t) => t.connection.sourcePoint.x)) -
    padPitch / 2 -
    w / 2
  if (near - far < (upper.length - 1) * pitch) return null
  const upperPorts = upper.map((_, i) => ({
    x: far + ((near - far) * i) / (upper.length - 1),
    y: sourceBoundary.maxY,
  }))
  const upperResult = yield* routeOrderedStage(
    make(upper, [...remote, separator, inner], true, upperPorts),
  )
  if (!upperResult) return null
  const tops = upperResult.map((p) => {
    const ss = p.segments.filter((s) => s.layer === targetLayer),
      last = ss.at(-1)!
    if (last.end.y <= last.start.y) return null
    return outer(
      byTerminal.get(p.connectionIndex)!,
      [ss[0]!.start, ...ss.map((s) => s.end)],
      true,
    )
  })
  if (tops.some((p) => !p)) return null
  const plans = [...remote, separator, inner, ...(tops as FanoutRoutePlan[])]
  if (plans.length !== bus.connections.length) return null
  const lengths = plans.map((p) => p.length)
  if (
    bus.maxLengthSkew !== undefined &&
    Math.max(...lengths) - Math.min(...lengths) > bus.maxLengthSkew + EPS
  )
    return null
  if (
    !fanoutPlansAreClear({
      plans,
      srj,
      sharedBoundary: bus.sharedBoundary,
      clearance: c,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    })
  )
    return null
  for (const p of plans)
    for (const other of sourceEscapes) {
      if (p.connectionIndex === other.connectionIndex) continue
      for (const s of p.segments) {
        if (
          other.via.spanLayers.includes(s.layer) &&
          distancePointToSegment(other.via.center, s.start, s.end) <
            other.via.diameter / 2 + s.width / 2 + c - EPS
        )
          return null
        for (const t of other.segments)
          if (
            s.layer === t.layer &&
            distanceSegmentToSegment(s.start, s.end, t.start, t.end) <
              (s.width + t.width) / 2 + c - EPS
          )
            return null
      }
    }
  return plans
}
const EPS = 1e-7
