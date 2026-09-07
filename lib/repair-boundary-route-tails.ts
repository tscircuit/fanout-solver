import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distance, distanceSegmentToSegment } from "./geometry"
import { fanoutPlansAreClear } from "./route-bus"
import { routeViaMinimalWindingAlternativesSteps } from "./route-via-minimal-winding"
import type {
  Bounds,
  FanoutEdge,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  RoutedSegment,
} from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

export interface RepairBoundaryRouteTailsParams {
  inputSrj: SimpleRouteJson
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  /** Unfinished source prefixes and earlier groups remain hard copper. */
  reservedPlans?: readonly FanoutRoutePlan[]
  layerNames: string[]
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  allowBlindAndBuriedVias?: boolean
  allowSameNetMerges?: boolean
  gridStep?: number
  gridOrigin?: Point2D
}

const EPSILON = 1e-7
const inward = (p: Point2D, edge: FanoutEdge, b: Bounds) =>
  edge === "left"
    ? p.x - b.minX
    : edge === "right"
      ? b.maxX - p.x
      : edge === "top"
        ? b.maxY - p.y
        : p.y - b.minY

/** Clip a segment to the bounded region where endpoint links can be repaired. */
function borderSegment(
  segment: RoutedSegment,
  edge: FanoutEdge,
  bounds: Bounds,
  width: number,
): RoutedSegment | null {
  const a = inward(segment.start, edge, bounds),
    b = inward(segment.end, edge, bounds)
  if (Math.min(a, b) > width) return null
  if (Math.max(a, b) <= width) return segment
  const t = (width - a) / (b - a)
  const cut = {
    x: segment.start.x + (segment.end.x - segment.start.x) * t,
    y: segment.start.y + (segment.end.y - segment.start.y) * t,
  }
  return { ...segment, ...(a > width ? { start: cut } : { end: cut }) }
}

function lastLayerPath(plan: FanoutRoutePlan) {
  let first = plan.segments.length - 1
  while (first > 0 && plan.segments[first - 1]!.layer === plan.targetLayer)
    first--
  const segments = plan.segments.slice(first)
  return {
    first,
    points: segments.length
      ? [segments[0]!.start, ...segments.map((s) => s.end)]
      : [],
  }
}

function withLastLayerPath(
  plan: FanoutRoutePlan,
  first: number,
  points: readonly Point2D[],
): FanoutRoutePlan {
  const segments = [
    ...plan.segments.slice(0, first),
    ...points.slice(1).flatMap((end, i) =>
      distance(points[i]!, end) > EPSILON
        ? [
            {
              start: points[i]!,
              end,
              layer: plan.targetLayer,
              width: plan.segments.at(-1)!.width,
            },
          ]
        : [],
    ),
  ]
  let traceStart = plan.trace.route.length
  while (traceStart > 0) {
    const p = plan.trace.route[traceStart - 1]!
    if (p.route_type !== "wire" || p.layer !== plan.targetLayer) break
    traceStart--
  }
  return {
    ...plan,
    segments,
    length: segments.reduce((sum, s) => sum + distance(s.start, s.end), 0),
    trace: {
      ...plan.trace,
      route: [
        ...plan.trace.route.slice(0, traceStart),
        ...points.map((p) => ({
          route_type: "wire" as const,
          x: p.x,
          y: p.y,
          layer: plan.targetLayer,
          width: plan.segments.at(-1)!.width,
        })),
      ],
    },
  }
}

/** Remove small cut/search spurs without touching earlier retained copper. */
function removeReversingTailCorners(
  original: readonly Point2D[],
  firstTailPoint: number,
): Point2D[] {
  const points = [...original]
  const octilinear = (a: Point2D, b: Point2D) => {
    const dx = Math.abs(b.x - a.x),
      dy = Math.abs(b.y - a.y)
    return dx < EPSILON || dy < EPSILON || Math.abs(dx - dy) < EPSILON
  }
  for (let i = Math.max(1, firstTailPoint); i < points.length - 1; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      c = points[i + 1]!,
      incoming = distance(a, b),
      outgoing = distance(b, c)
    if (
      incoming < EPSILON ||
      outgoing < EPSILON ||
      ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
        (incoming * outgoing) >=
        -EPSILON
    )
      continue
    // A temporary cut carries no incoming heading into the path search.
    // Its first steps can double back. Prefer deleting that corner, or trim
    // it to an axis-aligned shortcut ending on one of the original segments.
    if (octilinear(a, c)) {
      points.splice(i, 1)
      i--
      continue
    }
    const shortcuts: Point2D[] = []
    for (const axis of ["x", "y"] as const) {
      const outgoingT = (a[axis] - b[axis]) / (c[axis] - b[axis])
      if (outgoingT > EPSILON && outgoingT < 1 - EPSILON)
        shortcuts.push({
          x: b.x + (c.x - b.x) * outgoingT,
          y: b.y + (c.y - b.y) * outgoingT,
        })
      const incomingT = (c[axis] - a[axis]) / (b[axis] - a[axis])
      if (incomingT > EPSILON && incomingT < 1 - EPSILON)
        shortcuts.push({
          x: a.x + (b.x - a.x) * incomingT,
          y: a.y + (b.y - a.y) * incomingT,
        })
    }
    const shortcut = shortcuts.find(
      (point) => octilinear(a, point) && octilinear(point, c),
    )
    if (shortcut) points[i] = shortcut
    // Every shortcut remains provisional until the caller checks the entire
    // repaired cluster against all retained copper, pads, and physical vias.
  }
  return points
}

function inferGridOrigin(
  plans: readonly FanoutRoutePlan[],
  step: number,
): Point2D {
  const phase = (axis: "x" | "y") => {
    const counts = new Map<number, number>()
    for (const plan of plans)
      for (const point of lastLayerPath(plan).points.slice(0, -1)) {
        const raw = ((point[axis] % step) + step) % step
        const value =
          raw < 1e-6 || step - raw < 1e-6 ? 0 : Math.round(raw * 1e6) / 1e6
        counts.set(value, (counts.get(value) ?? 0) + 1)
      }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0
  }
  return { x: phase("x"), y: phase("y") }
}

/**
 * Replace conflicting final-layer boundary links without moving any real via,
 * source, or endpoint. The original buses remain complete and retain their
 * metadata; only temporary path-search terminals use the retained cutpoints.
 * Returns null when the bounded strip cannot produce fully clear copper.
 */
export function repairBoundaryRouteTails(
  params: RepairBoundaryRouteTailsParams,
): FanoutRoutePlan[] | null {
  const {
    inputSrj,
    preparedBuses,
    reservedPlans = [],
    traceWidth,
    clearance,
  } = params
  const pitch = traceWidth + clearance,
    step = params.gridStep ?? traceWidth
  if (!(pitch > 0) || !(step > 0) || !Number.isFinite(step))
    throw new Error(
      "FanoutSolver: boundary tail repair requires positive finite trace/grid spacing",
    )
  const owners = new Map(
    preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const plans = [...params.plans]
  const groups = new Map<string, FanoutRoutePlan[]>()
  for (const plan of plans) {
    const owner = owners.get(plan.connectionIndex)
    if (!owner)
      throw new Error(
        `FanoutSolver: missing prepared boundary-tail connection ${plan.connectionIndex}`,
      )
    if (
      plan.termination.type !== "boundary" ||
      !plan.exitEdge ||
      Math.abs(
        inward(plan.exitPoint, plan.exitEdge, owner.bus.sharedBoundary),
      ) > EPSILON
    )
      continue
    const key = `${plan.exitEdge}:${plan.targetLayer}`
    const group = groups.get(key) ?? []
    group.push(plan)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const edge = group[0]!.exitEdge!,
      layer = group[0]!.targetLayer,
      boundary = owners.get(group[0]!.connectionIndex)!.bus.sharedBoundary
    const maximumWidth = Math.min(
      24 * pitch,
      (edge === "left" || edge === "right"
        ? boundary.maxX - boundary.minX
        : boundary.maxY - boundary.minY) / 3,
    )
    const tails = group.map((plan) =>
      plan.segments
        .filter((s) => s.layer === layer)
        .flatMap((s) => borderSegment(s, edge, boundary, maximumWidth) ?? []),
    )
    // Include both members of every conflict, even when one individual path
    // could already be normalized: its final approach may fence its neighbor.
    const selected = new Set<FanoutRoutePlan>()
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        if (
          tails[i]!.some((a) =>
            tails[j]!.some(
              (b) =>
                distanceSegmentToSegment(a.start, a.end, b.start, b.end) <
                (a.width + b.width) / 2 + clearance - EPSILON,
            ),
          )
        ) {
          selected.add(group[i]!)
          selected.add(group[j]!)
        }
      }
    if (!selected.size) continue
    // A valid adjacent link can still close the connector corridor at a
    // minimum-pitch terminal. Repair that tightly spaced endpoint cluster too.
    let grew = true
    while (grew) {
      grew = false
      for (const plan of group)
        if (
          !selected.has(plan) &&
          [...selected].some(
            (other) =>
              distance(plan.exitPoint, other.exitPoint) <= 2 * pitch + EPSILON,
          )
        ) {
          selected.add(plan)
          grew = true
        }
    }
    const active = group.filter((plan) => selected.has(plan))
    if (active.length > 24) return null
    const origin = params.gridOrigin ?? inferGridOrigin(active, step)
    let repaired: FanoutRoutePlan[] | null = null
    for (const multiplier of [8, 16, 24]) {
      const width = Math.min(multiplier * pitch, maximumWidth)
      const axis = edge === "left" || edge === "right" ? "x" : "y"
      const sign = edge === "left" || edge === "bottom" ? 1 : -1
      const border =
        edge === "left"
          ? boundary.minX
          : edge === "right"
            ? boundary.maxX
            : edge === "top"
              ? boundary.maxY
              : boundary.minY
      const requested = border + sign * width
      const cutAxis =
        origin[axis] +
        (sign > 0
          ? Math.ceil((requested - origin[axis]) / step)
          : Math.floor((requested - origin[axis]) / step)) *
          step
      const depth = (cutAxis - border) * sign
      const cuts = active.map((plan) => {
        const { first, points } = lastLayerPath(plan)
        const index = points.findLastIndex(
          (p) => inward(p, edge, boundary) >= depth - EPSILON,
        )
        if (index < 0 || index >= points.length - 1) return null
        const a = points[index]!,
          b = points[index + 1]!,
          t = (cutAxis - a[axis]) / (b[axis] - a[axis])
        if (!Number.isFinite(t) || t < -EPSILON || t > 1 + EPSILON) return null
        const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        const prefix = [
          ...points.slice(0, index + 1),
          ...(distance(a, point) > EPSILON ? [point] : []),
        ]
        if (first + prefix.length - 1 < (plan.sourceEscapeSegmentCount ?? 1))
          return null
        return { plan, first, prefix, point }
      })
      if (cuts.some((c) => !c)) continue
      const completeCuts = cuts.filter((c) => c !== null)
      const stable = [
        ...plans.filter((p) => !selected.has(p)),
        ...reservedPlans,
      ]
      const prefixes = completeCuts.map((c) => ({
        ...withLastLayerPath(c.plan, c.first, c.prefix),
        exitPoint: c.point,
      }))
      const blockers = [...stable, ...prefixes]
      const terminals = completeCuts.map((c) => ({
        connection: {
          ...owners.get(c.plan.connectionIndex)!.connection,
          sourcePoint: { ...c.point, layer },
          sourceLayer: layer,
        },
        viaPoint: c.point,
        exitPoint: c.plan.exitPoint,
      }))
      const strip = { ...boundary }
      if (edge === "left")
        strip.maxX = Math.min(boundary.maxX, cutAxis + 3 * pitch)
      if (edge === "right")
        strip.minX = Math.max(boundary.minX, cutAxis - 3 * pitch)
      if (edge === "bottom")
        strip.maxY = Math.min(boundary.maxY, cutAxis + 3 * pitch)
      if (edge === "top")
        strip.minY = Math.max(boundary.minY, cutAxis - 3 * pitch)
      const perpendicular = axis === "x" ? "y" : "x",
        coordinates = terminals.flatMap((t) => [
          t.viaPoint[perpendicular],
          t.exitPoint[perpendicular],
        ])
      if (perpendicular === "x") {
        strip.minX = Math.max(strip.minX, Math.min(...coordinates) - 3 * pitch)
        strip.maxX = Math.min(strip.maxX, Math.max(...coordinates) + 3 * pitch)
      } else {
        strip.minY = Math.max(strip.minY, Math.min(...coordinates) - 3 * pitch)
        strip.maxY = Math.min(strip.maxY, Math.max(...coordinates) + 3 * pitch)
      }
      const bus = {
        ...owners.get(active[0]!.connectionIndex)!.bus,
        connections: terminals.map((t) => t.connection),
        sharedBoundary: strip,
      }
      const steps = routeViaMinimalWindingAlternativesSteps(
        {
          ...params,
          srj: inputSrj,
          bus,
          terminals,
          targetLayer: layer,
          // These temporary terminals start at retained same-layer cuts.
          sourceEscapePaths: undefined,
          acceptedPlans: blockers,
          reservedVias: blockers.flatMap((p) =>
            [p.via, ...(p.additionalVias ?? []), p.planeEndpointVia]
              .filter((v) => !!v)
              .map((via) => ({ connectionName: p.connectionName, via })),
          ),
          gridStep: step,
          gridOrigin: origin,
          gridStepDivisor: 2,
          alignGridToPads: true,
          heuristicWeight: 2,
          maximumRouteOrderAttempts: 72,
          reserveTerminalExitPoints: true,
          adaptiveRouteOrder: true,
          allowSourceLayerRouting: true,
        },
        1,
        false,
      )
      let next = steps.next()
      while (!next.done) next = steps.next()
      const result = next.value[0]
      if (!result) continue
      const candidates = completeCuts.map((c) => {
        const tail = result.find(
          (p) => p.connectionIndex === c.plan.connectionIndex,
        )!
        if (!tail || tail.via || tail.additionalVias?.length)
          throw new Error(
            "FanoutSolver: boundary-tail repair added a physical via",
          )
        const points = removeReversingTailCorners(
          [...c.prefix, ...tail.segments.map((s) => s.end)],
          c.prefix.length - 1,
        )
        return withLastLayerPath(c.plan, c.first, points)
      })
      if (
        !fanoutPlansAreClear({
          plans: candidates,
          srj: {
            ...inputSrj,
            traces: [
              ...(inputSrj.traces ?? []),
              ...stable.flatMap((p) => [
                p.trace,
                ...(p.planeEndpointTrace ? [p.planeEndpointTrace] : []),
              ]),
            ],
          },
          sharedBoundary: boundary,
          clearance,
          allowBlindAndBuriedVias: params.allowBlindAndBuriedVias,
          allowSameNetMerges: params.allowSameNetMerges,
        })
      )
        continue
      repaired = candidates
      break
    }
    if (!repaired) return null
    for (const plan of repaired)
      plans[
        plans.findIndex((p) => p.connectionIndex === plan.connectionIndex)
      ] = plan
  }
  const combined = [...plans, ...reservedPlans]
  const validation = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: {
      ...inputSrj,
      traces: [
        ...(inputSrj.traces ?? []),
        ...combined.flatMap((p) => [
          p.trace,
          ...(p.planeEndpointTrace ? [p.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance,
    allowBlindAndBuriedVias: params.allowBlindAndBuriedVias,
  })
  return validation.valid ? plans : null
}
