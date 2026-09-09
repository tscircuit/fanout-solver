import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToObstacle,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "./geometry"
import { getDeclaredDifferentialPairs } from "./get-declared-differential-pairs"
import { getAllRoutedTraceCopper } from "./get-routed-trace-copper"
import {
  addedTuningViasAreSelfClear,
  createPlanWithSegments,
} from "./match-bus-lengths"
import { changedFanoutCopperIsSelfClear } from "./normalize-fanout-plan-corners"
import { createFanoutPlanClearanceValidator } from "./route-bus"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  RoutedSegment,
} from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

const EPSILON = 1e-7
const MAX_NODES = 1_024
const MAX_EDGE_CHECKS = 30_000
const MAX_EXPANSIONS = 8_000

interface Params {
  inputSrj: SimpleRouteJson
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  bus: PreparedBus
  clearance: number
}
interface Frame {
  point(p: Point2D): Point2D
  unpoint(p: Point2D): Point2D
}
function frame(edge: string | undefined): Frame | null {
  if (edge === "bottom")
    return {
      point: (p) => ({ x: p.x, y: -p.y }),
      unpoint: (p) => ({ x: p.x, y: -p.y }),
    }
  if (edge === "top")
    return {
      point: (p) => ({ x: p.x, y: p.y }),
      unpoint: (p) => ({ x: p.x, y: p.y }),
    }
  if (edge === "left")
    return {
      point: (p) => ({ x: p.y, y: -p.x }),
      unpoint: (p) => ({ x: -p.y, y: p.x }),
    }
  if (edge === "right")
    return {
      point: (p) => ({ x: p.y, y: p.x }),
      unpoint: (p) => ({ x: p.y, y: p.x }),
    }
  return null
}
function heading(a: Point2D, b: Point2D): number {
  return (Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) + 8) % 8
}
function turnsClear(before: number, after: number): boolean {
  const delta = (after - before + 8) % 8
  return delta <= 1 || delta === 7
}
function routeHeadingsClear(segments: readonly RoutedSegment[]) {
  return segments.every((s, i) => {
    const dx = Math.abs(s.end.x - s.start.x),
      dy = Math.abs(s.end.y - s.start.y)
    if (Math.min(dx, dy) > EPSILON && Math.abs(dx - dy) > EPSILON) return false
    const previous = segments[i - 1]
    return (
      !previous ||
      previous.layer !== s.layer ||
      turnsClear(heading(previous.start, previous.end), heading(s.start, s.end))
    )
  })
}
/** Two shortest axis/diagonal connectors; their sole bend is at most 45 degrees. */
function connectors(a: Point2D, b: Point2D): Point2D[][] {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const diagonal = Math.min(Math.abs(dx), Math.abs(dy))
  const sx = Math.sign(dx),
    sy = Math.sign(dy)
  return [
    [a, { x: a.x + sx * diagonal, y: a.y + sy * diagonal }, b],
    [a, { x: b.x - sx * diagonal, y: b.y - sy * diagonal }, b],
  ].map((path) =>
    path.filter((p, i) => i === 0 || distance(p, path[i - 1]!) > EPSILON),
  )
}

/**
 * Free one short lane's first via without touching any other accepted copper.
 * Candidate sites come from its original target path. The source path follows
 * a bounded visibility graph around physical pad/via clearances, then a U turn
 * beside the pad field. Original layers, targets, bus and pair limits stay hard.
 */
export function relocateShortLaneFirstVia(
  params: Params,
): FanoutRoutePlan[] | null {
  const { inputSrj, plans, preparedBuses, bus, clearance } = params
  if (
    bus.termination.type !== "boundary" ||
    bus.maxLengthSkew === undefined ||
    bus.connections.length < 3
  )
    return null
  const byIndex = new Map(plans.map((p) => [p.connectionIndex, p]))
  const connections = preparedBuses.flatMap((b) => b.connections)
  if (
    byIndex.size !== inputSrj.connections.length ||
    plans.length !== byIndex.size ||
    connections.length !== byIndex.size ||
    connections.some(
      (c) =>
        byIndex.get(c.connectionIndex)?.connectionName !== c.connection.name ||
        byIndex.get(c.connectionIndex)?.sourceObstacle !== c.sourceObstacle,
    )
  )
    return null
  const own = bus.connections.map((c) => byIndex.get(c.connectionIndex)!)
  const maximumLength = Math.max(...own.map((p) => p.length))
  const deficient = own.filter(
    (p) => maximumLength - p.length > bus.maxLengthSkew! + 1e-6,
  )
  if (deficient.length !== 1) return null
  const plan = deficient[0]!,
    via = plan.via,
    transform = frame(plan.exitEdge)
  if (
    !via ||
    !transform ||
    plan.sourceLayer === plan.targetLayer ||
    plan.additionalVias?.length ||
    plan.planeEndpointVia ||
    !bus.allowedLayers?.includes(plan.targetLayer) ||
    !(bus.routableEscapeLayers ?? bus.allowedLayers).includes(plan.targetLayer)
  )
    return null
  if (
    getDeclaredDifferentialPairs(inputSrj).some((pair) =>
      pair.connectionIndices.includes(plan.connectionIndex),
    )
  )
    return null
  const source = plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1)
  if (
    !source.length ||
    source.some((s) => s.layer !== plan.sourceLayer) ||
    distance(source[0]!.start, plan.sourcePoint) > EPSILON ||
    distance(source.at(-1)!.end, via.center) > EPSILON
  )
    return null
  if (
    plan.segments.slice(source.length).some((s) => s.layer !== plan.targetLayer)
  )
    return null
  const width = source[0]!.width,
    wireRadius = width / 2 + clearance
  const component = plan.sourceObstacle.componentId
  if (!component) return null
  const pads = inputSrj.obstacles.filter(
    (o) =>
      o.componentId === component &&
      o.layers.includes(plan.sourceLayer) &&
      (o as { shape?: string }).shape === "circle",
  )
  if (pads.length < 9) return null
  const padPoints = pads.map((o) => transform.point(o.center))
  const unique = (values: number[]) =>
    [...new Set(values.map((v) => Math.round(v * 1e6) / 1e6))].sort(
      (a, b) => a - b,
    )
  const columns = unique(padPoints.map((p) => p.x)),
    rows = unique(padPoints.map((p) => p.y))
  const gaps = [
    ...columns.slice(1).map((x, i) => x - columns[i]!),
    ...rows.slice(1).map((y, i) => y - rows[i]!),
  ].filter((d) => d > EPSILON)
  const pitch = Math.min(...gaps)
  if (
    !Number.isFinite(pitch) ||
    pitch <= 2 * wireRadius ||
    columns.length < 3 ||
    rows.length < 3
  )
    return null
  const start = transform.point(via.center),
    innerY = rows.at(-1)! - pitch / 2
  if (start.y >= innerY || start.y < rows[0]! - pitch) return null
  const requiredAddition =
    maximumLength - bus.maxLengthSkew - plan.length + 1e-6
  const others = plans.filter((p) => p !== plan)
  const supplied = getAllRoutedTraceCopper(inputSrj, false)
  const foreignSegments = [
    ...others.flatMap((p) => [
      ...p.segments,
      ...(p.planeEndpointSegments ?? []),
    ]),
    ...supplied.flatMap((t) => t.segments),
  ]
  const foreignVias = [
    ...others.flatMap((p) =>
      [p.via, ...(p.additionalVias ?? []), p.planeEndpointVia].filter(
        (v) => v !== undefined,
      ),
    ),
    ...supplied.flatMap((t) => t.vias),
  ]
  const sourceSegments = foreignSegments.filter(
    (s) => s.layer === plan.sourceLayer,
  )
  const sourceVias = foreignVias.filter((v) =>
    v.spanLayers.includes(plan.sourceLayer),
  )
  const sourceObstacles = inputSrj.obstacles.filter((o) =>
    o.layers.includes(plan.sourceLayer),
  )
  const segmentClear = (a: Point2D, b: Point2D): boolean => {
    const segment = {
      start: transform.unpoint(a),
      end: transform.unpoint(b),
      width,
      layer: plan.sourceLayer,
    }
    const bounds = bus.sharedBoundary
    if (
      [segment.start, segment.end].some(
        (p) =>
          p.x - wireRadius < bounds.minX ||
          p.x + wireRadius > bounds.maxX ||
          p.y - wireRadius < bounds.minY ||
          p.y + wireRadius > bounds.maxY,
      )
    )
      return false
    return (
      sourceObstacles.every(
        (o) => distanceSegmentToObstacle(segment, o) >= wireRadius - EPSILON,
      ) &&
      sourceSegments.every(
        (s) =>
          distanceSegmentToSegment(
            segment.start,
            segment.end,
            s.start,
            s.end,
          ) >=
          (width + s.width) / 2 + clearance - EPSILON,
      ) &&
      sourceVias.every(
        (v) =>
          distancePointToSegment(v.center, segment.start, segment.end) >=
          v.diameter / 2 + wireRadius - EPSILON,
      )
    )
  }
  const viaClear = (center: Point2D): boolean => {
    const radius = via.diameter / 2 + clearance
    const bounds = bus.sharedBoundary
    if (
      center.x - radius < bounds.minX ||
      center.x + radius > bounds.maxX ||
      center.y - radius < bounds.minY ||
      center.y + radius > bounds.maxY
    )
      return false
    return (
      inputSrj.obstacles.every(
        (o) =>
          !o.layers.some((l) => via.spanLayers.includes(l)) ||
          distancePointToObstacle(center, o) >= radius - EPSILON,
      ) &&
      foreignSegments.every(
        (s) =>
          !via.spanLayers.includes(s.layer) ||
          distancePointToSegment(center, s.start, s.end) >=
            radius + s.width / 2 - EPSILON,
      ) &&
      foreignVias.every(
        (v) =>
          !v.spanLayers.some((l) => via.spanLayers.includes(l)) ||
          distance(center, v.center) >= radius + v.diameter / 2 - EPSILON,
      )
    )
  }
  const validator = createFanoutPlanClearanceValidator({
    srj: inputSrj,
    sharedBoundary: bus.sharedBoundary,
    clearance,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  })
  if (!validator(plans)) return null
  const sites = plan.segments
    .flatMap((s, index) => {
      if (index < source.length || distance(s.start, s.end) < width * 2)
        return []
      return [0.5, 0.25, 0.75].map((fraction) => ({
        index,
        center: {
          x: s.start.x + (s.end.x - s.start.x) * fraction,
          y: s.start.y + (s.end.y - s.start.y) * fraction,
        },
      }))
    })
    .filter(({ center }) => {
      const p = transform.point(center)
      return (
        p.y > rows.at(-1)! + pitch / 2 &&
        p.y < rows.at(-1)! + pitch * 1.5 &&
        viaClear(center)
      )
    })
    .slice(0, 6)
  let edgeChecks = 0
  for (const site of sites) {
    const goal = transform.point(site.center)
    const fieldVias = sourceVias
      .map((v) => ({ ...v, point: transform.point(v.center) }))
      .filter(
        (v) =>
          v.point.y >= rows.at(-1)! - pitch / 2 &&
          v.point.y <= rows.at(-1)! + pitch * 0.75 &&
          v.point.x >= columns[0]! - pitch &&
          v.point.x <= columns.at(-1)! + pitch,
      )
    const outerY =
      Math.max(
        rows.at(-1)! + pitch / 2,
        ...fieldVias.map((v) => v.point.y + v.diameter / 2 + wireRadius),
      ) +
      clearance / 10
    const tangentGaps = columns.slice(1).map((x, i) => (x + columns[i]!) / 2)
    for (const sign of [1, -1]) {
      const desired = goal.x + sign * (requiredAddition / 2 + pitch * 2)
      const turnX = tangentGaps
        .filter((x) => sign * (x - goal.x) > pitch)
        .sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired))[0]
      if (turnX === undefined) continue
      const chamfer = Math.min(pitch / 8, (outerY - innerY) / 4)
      const anchor = { x: turnX - sign * chamfer, y: innerY }
      const rise = outerY - goal.y
      if (rise < 0 || sign * (anchor.x - goal.x) <= rise + chamfer) continue
      const tail = [
        anchor,
        { x: turnX, y: innerY + chamfer },
        { x: turnX, y: outerY - chamfer },
        { x: turnX - sign * chamfer, y: outerY },
        { x: goal.x + sign * rise, y: outerY },
        goal,
      ].filter(
        // A via on the return line needs no additional zero-length lead.
        (p, i, points) =>
          i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y,
      )
      if (tail.slice(1).some((p, i) => !segmentClear(tail[i]!, p))) continue
      const minX = Math.min(start.x, goal.x, turnX) - pitch,
        maxX = Math.max(start.x, goal.x, turnX) + pitch
      const minY = start.y - pitch / 2,
        maxY = innerY + pitch / 2
      const discs = [
        ...sourceObstacles
          .filter((o) => (o as { shape?: string }).shape === "circle")
          .map((o) => ({
            center: transform.point(o.center),
            radius: o.width / 2 + wireRadius,
          })),
        ...sourceVias.map((v) => ({
          center: transform.point(v.center),
          radius: v.diameter / 2 + wireRadius,
        })),
      ].filter(
        (d) =>
          d.center.x >= minX - pitch &&
          d.center.x <= maxX + pitch &&
          d.center.y >= minY - pitch &&
          d.center.y <= maxY + pitch,
      )
      const nodes: Point2D[] = [start, anchor]
      for (const disc of discs) {
        const gap = Math.min(
          ...discs
            .filter((other) => other !== disc)
            .map(
              (other) =>
                distance(disc.center, other.center) -
                disc.radius -
                other.radius,
            )
            .filter((d) => d > EPSILON),
        )
        const radius = disc.radius + Math.min(clearance / 10, gap / 4)
        const corner = radius * (Math.SQRT2 - 1)
        for (const [x, y] of [
          [radius, corner],
          [corner, radius],
          [-corner, radius],
          [-radius, corner],
          [-radius, -corner],
          [-corner, -radius],
          [corner, -radius],
          [radius, -corner],
        ]) {
          const p = { x: disc.center.x + x!, y: disc.center.y + y! }
          if (
            p.x < minX ||
            p.x > maxX ||
            p.y < minY ||
            p.y > maxY ||
            !segmentClear(p, p)
          )
            continue
          if (!nodes.some((n) => distance(n, p) < EPSILON)) nodes.push(p)
          if (nodes.length > MAX_NODES) return null
        }
      }
      const neighbors = nodes.map((node, index) =>
        nodes
          .map((other, otherIndex) => ({
            index: otherIndex,
            d: distance(node, other),
          }))
          .filter(
            (n) => n.index !== index && (n.d <= pitch * 2.5 || n.index === 1),
          )
          .sort((a, b) => a.d - b.d)
          .slice(0, 28)
          .map((n) => n.index),
      )
      const initialHeading = heading(
        transform.point(source.at(-1)!.start),
        start,
      )
      type State = {
        node: number
        heading: number
        cost: number
        score: number
        previous?: State
        path?: Point2D[]
      }
      const queue: State[] = [
        {
          node: 0,
          heading: initialHeading,
          cost: 0,
          score: distance(start, anchor),
        },
      ]
      const best = new Map<number, number>([[initialHeading, 0]])
      const edgeCache = new Map<string, Point2D[][]>()
      let final: State | undefined
      for (
        let expanded = 0;
        queue.length && expanded < MAX_EXPANSIONS;
        expanded++
      ) {
        let bestIndex = 0
        for (let i = 1; i < queue.length; i++)
          if (queue[i]!.score < queue[bestIndex]!.score) bestIndex = i
        const state = queue.splice(bestIndex, 1)[0]!
        if (state.cost !== best.get(state.node * 8 + state.heading)) continue
        if (
          state.node === 1 &&
          turnsClear(state.heading, heading(tail[0]!, tail[1]!))
        ) {
          final = state
          break
        }
        for (const next of neighbors[state.node]!) {
          const key = `${state.node}:${next}`
          let edges = edgeCache.get(key)
          if (!edges) {
            if (++edgeChecks > MAX_EDGE_CHECKS) return null
            edges = connectors(nodes[state.node]!, nodes[next]!).filter(
              (path) =>
                path.length > 1 &&
                path.slice(1).every((p, i) => segmentClear(path[i]!, p)),
            )
            edgeCache.set(key, edges)
          }
          for (const path of edges) {
            if (!turnsClear(state.heading, heading(path[0]!, path[1]!)))
              continue
            const nextHeading = heading(path.at(-2)!, path.at(-1)!)
            const cost =
              state.cost +
              path
                .slice(1)
                .reduce((sum, p, i) => sum + distance(path[i]!, p), 0)
            const nextKey = next * 8 + nextHeading
            if (cost >= (best.get(nextKey) ?? Infinity) - EPSILON) continue
            best.set(nextKey, cost)
            queue.push({
              node: next,
              heading: nextHeading,
              cost,
              score: cost + distance(nodes[next]!, anchor),
              previous: state,
              path,
            })
          }
        }
      }
      if (!final) continue
      const paths: Point2D[][] = []
      for (
        let state: State | undefined = final;
        state?.previous;
        state = state.previous
      )
        paths.push(state.path!)
      const points = [
        start,
        ...paths.reverse().flatMap((path) => path.slice(1)),
        ...tail.slice(1),
      ]
      const extension = points.slice(1).map((end, i) => ({
        start: transform.unpoint(points[i]!),
        end: transform.unpoint(end),
        width,
        layer: plan.sourceLayer,
      }))
      const candidate = createPlanWithSegments(
        {
          ...plan,
          via: { ...via, center: site.center },
          sourceEscapeSegmentCount: source.length,
        },
        [
          ...source,
          ...extension,
          { ...plan.segments[site.index]!, start: site.center },
          ...plan.segments.slice(site.index + 1),
        ],
        true,
      )
      if (
        !candidate ||
        candidate.length < maximumLength - bus.maxLengthSkew - EPSILON ||
        candidate.length >
          Math.min(...own.filter((p) => p !== plan).map((p) => p.length)) +
            bus.maxLengthSkew +
            EPSILON ||
        !routeHeadingsClear(candidate.segments)
      )
        continue
      const changed = new Set(extension.map((_, i) => source.length + i))
      changed.add(candidate.sourceEscapeSegmentCount!)
      if (
        !changedFanoutCopperIsSelfClear(
          { ...plan, via: candidate.via },
          candidate.segments,
          clearance,
          changed,
        ) ||
        !addedTuningViasAreSelfClear(candidate, [candidate.via!], clearance)
      )
        continue
      if (
        extension.some(
          (s) =>
            distanceSegmentToObstacle(s, plan.sourceObstacle) <
            wireRadius - EPSILON,
        )
      )
        continue
      const result = plans.map((p) => (p === plan ? candidate : p))
      if (!validator(result)) continue
      if (
        !validateRoutedCopperDrc({
          inputSrj,
          routedSrj: {
            ...inputSrj,
            traces: [
              ...(inputSrj.traces ?? []),
              ...result.flatMap((p) => [
                p.trace,
                ...(p.planeEndpointTrace ? [p.planeEndpointTrace] : []),
              ]),
            ],
          },
          clearance,
          allowBlindAndBuriedVias: false,
        }).valid
      )
        continue
      return result
    }
  }
  return null
}
