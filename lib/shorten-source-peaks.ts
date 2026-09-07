import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import { fanoutPlansAreClear, fanoutPlansAreMutuallyClear } from "./route-bus"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type {
  ShortenSourceCornersParams,
  ShortenSourceCornersResult,
} from "./shorten-source-corners"
import type { FanoutRoutePlan, Point2D, RoutedSegment } from "./types"

const EPSILON = 1e-7

/** Move an existing axis/45/axis/45/axis source detour inward. Endpoints,
 * primary vias, and all copper after the first via are preserved exactly.
 * Candidates are checked against every completed route and pending source.
 */
export function shortenSourceEscapePeaks(
  params: ShortenSourceCornersParams,
): ShortenSourceCornersResult {
  const rounds = params.maximumRounds ?? 4
  const limit = params.maximumCandidates ?? 4096
  if (
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isFinite(params.traceWidth) ||
    params.traceWidth <= 0 ||
    !Number.isFinite(params.clearance) ||
    params.clearance < 0
  )
    throw Error(
      "Source peak shortening requires positive bounded search limits and width",
    )
  if (
    params.minimumRetainedLengthByConnectionIndex &&
    [...params.minimumRetainedLengthByConnectionIndex.values()].some(
      (n) => !Number.isFinite(n) || n < 0,
    )
  )
    throw Error(
      "Source peak shortening requires finite nonnegative length floors",
    )
  const prepared = new Map(
    params.preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const escapes = new Map(
    params.sourceEscapes.map((e) => [e.connectionIndex, e]),
  )
  const working = [...params.plans]
  const supplied = new Set(working.map((p) => p.connectionIndex))
  if (
    escapes.size !== params.sourceEscapes.length ||
    supplied.size !== working.length
  )
    throw Error("Source peak shortening requires unique identities")
  for (const e of params.sourceEscapes) {
    const holder = prepared.get(e.connectionIndex)
    if (
      !holder ||
      !e.segments.length ||
      e.connectionName !== holder.connection.connection.name ||
      distance(e.segments[0].start, holder.connection.sourcePoint) > EPSILON ||
      distance(e.segments.at(-1)!.end, e.via.center) > EPSILON
    )
      throw Error("Source peak shortening requires original source identities")
    if (supplied.has(e.connectionIndex)) continue
    const plan = buildViaMinimalWindingPlan({
      ...params,
      viaDiameter: e.via.diameter,
      viaHoleDiameter: e.via.holeDiameter,
      allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
      bus: holder.bus,
      targetLayer: e.via.toLayer,
      terminal: {
        connection: holder.connection,
        viaPoint: e.via.center,
        exitPoint: e.via.center,
      },
      sourceEscapePoints: [
        e.segments[0].start,
        ...e.segments.map((s) => s.end),
      ],
      targetLayerPoints: [e.via.center, e.via.center],
    })
    working.push({
      ...plan,
      termination: { type: "plane", layer: e.via.toLayer },
      via: e.via,
      sourceEscapeSegmentCount: e.segments.length,
    })
  }
  for (const plan of working) {
    const e = escapes.get(plan.connectionIndex)
    const holder = prepared.get(plan.connectionIndex)
    const count = plan.sourceEscapeSegmentCount ?? 1
    if (
      !e ||
      !holder ||
      !plan.via ||
      count !== e.segments.length ||
      count > plan.segments.length ||
      plan.sourceObstacle !== holder.connection.sourceObstacle ||
      distance(plan.via.center, e.via.center) > EPSILON ||
      plan.segments
        .slice(0, count)
        .some(
          (s, i) =>
            s.layer !== e.segments[i].layer ||
            s.width !== e.segments[i].width ||
            distance(s.start, e.segments[i].start) > EPSILON ||
            distance(s.end, e.segments[i].end) > EPSILON,
        )
    )
      throw Error("Source peak shortening requires coherent source prefixes")
  }
  const sharedBoundary = params.preparedBuses[0]?.sharedBoundary
  if (!sharedBoundary) {
    if (working.length)
      throw Error("Source peak shortening requires a shared boundary")
    return {
      plans: [],
      sourceEscapes: [...params.sourceEscapes],
      candidateCount: 0,
      changedCornerCount: 0,
    }
  }
  if (
    params.preparedBuses.some((b) =>
      Object.keys(sharedBoundary).some(
        (k) =>
          b.sharedBoundary[k as keyof typeof sharedBoundary] !==
          sharedBoundary[k as keyof typeof sharedBoundary],
      ),
    )
  )
    throw Error("Source peak shortening requires one shared boundary")
  if (!fanoutPlansAreClear({ ...params, sharedBoundary, plans: working }))
    throw Error("Source peak shortening requires initially clear copper")
  let candidateCount = 0
  let changedCornerCount = 0
  for (let round = 0; round < rounds && candidateCount < limit; round++) {
    let changed = false
    for (
      let index = 0;
      index < working.length && candidateCount < limit;
      index++
    ) {
      let plan = working[index]
      const floor = params.minimumRetainedLengthByConnectionIndex?.get(
        plan.connectionIndex,
      )
      if (params.minimumRetainedLengthByConnectionIndex && floor === undefined)
        continue
      for (let rotation = 0; rotation < 4 && candidateCount < limit; rotation++)
        for (const mirror of [1, -1]) {
          const to = (p: Point2D): Point2D => {
            const rotated =
              rotation === 0
                ? p
                : rotation === 1
                  ? { x: -p.y, y: p.x }
                  : rotation === 2
                    ? { x: -p.x, y: -p.y }
                    : { x: p.y, y: -p.x }
            return { x: rotated.x * mirror, y: rotated.y }
          }
          const from = (p: Point2D): Point2D => {
            const q = { x: p.x * mirror, y: p.y }
            return rotation === 0
              ? q
              : rotation === 1
                ? { x: q.y, y: -q.x }
                : rotation === 2
                  ? { x: -q.x, y: -q.y }
                  : { x: -q.y, y: q.x }
          }
          const sourceEscape = escapes.get(plan.connectionIndex)!
          const points = [
            sourceEscape.segments[0].start,
            ...sourceEscape.segments.map((s) => s.end),
          ].map(to)
          if (points.length < 5) continue
          const roof = Math.max(...points.map((p) => p.y))
          const first = points.findIndex((p) => Math.abs(p.y - roof) < EPSILON)
          const last = points.findLastIndex(
            (p) => Math.abs(p.y - roof) < EPSILON,
          )
          if (first < 1 || last !== first + 1 || last >= points.length - 1)
            continue
          const anchor = points[first - 1]
          const end = points[last + 1]
          const a = points[first]
          const b = points[last]
          if (
            a.x <= anchor.x + EPSILON ||
            b.x <= a.x + EPSILON ||
            end.x <= b.x + EPSILON ||
            Math.abs(a.x - anchor.x - (a.y - anchor.y)) > EPSILON ||
            Math.abs(end.x - b.x - (b.y - end.y)) > EPSILON
          )
            continue
          for (
            let track =
              Math.max(anchor.y, end.y) + params.traceWidth + params.clearance;
            track < roof - EPSILON && candidateCount < limit;
            track += params.traceWidth
          ) {
            const left = { x: anchor.x + track - anchor.y, y: track }
            const right = { x: end.x - (track - end.y), y: track }
            if (left.x >= right.x - EPSILON) break
            candidateCount++
            const path = [
              ...points.slice(0, first - 1),
              anchor,
              left,
              right,
              end,
              ...points.slice(last + 2),
            ].map(from)
            path[0] = sourceEscape.segments[0].start
            path[path.length - 1] = sourceEscape.segments.at(-1)!.end
            const sourceSegments = path.slice(1).map((end, i) => ({
              start: path[i],
              end,
              layer: sourceEscape.segments[0].layer,
              width: sourceEscape.segments[0].width,
            }))
            const segments = [
              ...sourceSegments,
              ...plan.segments.slice(plan.sourceEscapeSegmentCount ?? 1),
            ]
            const length = [
              ...segments,
              ...(plan.planeEndpointSegments ?? []),
            ].reduce((sum, s) => sum + distance(s.start, s.end), 0)
            if (
              length >= plan.length - EPSILON ||
              length < (floor ?? 0) - EPSILON
            )
              continue
            if (!validShape(segments)) continue
            const viaIndex = plan.trace.route.findIndex(
              (p) => p.route_type === "via",
            )
            const firstWire = plan.trace.route[0]
            const lastWire = plan.trace.route[viaIndex - 1]
            if (
              viaIndex < 1 ||
              firstWire.route_type !== "wire" ||
              lastWire.route_type !== "wire"
            )
              throw Error(
                "Source peak shortening requires an emitted source prefix",
              )
            const candidate: FanoutRoutePlan = {
              ...plan,
              segments,
              length,
              sourceEscapeSegmentCount: sourceSegments.length,
              trace: {
                ...plan.trace,
                route: [
                  firstWire,
                  ...sourceSegments.map((s, i) => ({
                    ...(i === sourceSegments.length - 1 ? lastWire : {}),
                    route_type: "wire" as const,
                    ...s.end,
                    width: s.width,
                    layer: s.layer,
                  })),
                  ...plan.trace.route.slice(viaIndex),
                ],
              },
            }
            if (
              !fanoutPlansAreClear({
                ...params,
                sharedBoundary,
                plans: [candidate],
              }) ||
              working.some(
                (other, i) =>
                  i !== index &&
                  !fanoutPlansAreMutuallyClear({
                    ...params,
                    plans: [candidate, other],
                  }),
              )
            )
              continue
            const laterVias = [
              ...(plan.additionalVias ?? []),
              ...(plan.planeEndpointVia ? [plan.planeEndpointVia] : []),
            ]
            if (
              sourceSegments.some((segment) =>
                laterVias.some(
                  (via) =>
                    via.spanLayers.includes(segment.layer) &&
                    distancePointToSegment(
                      via.center,
                      segment.start,
                      segment.end,
                    ) <
                      via.diameter / 2 +
                        segment.width / 2 +
                        params.clearance -
                        EPSILON,
                ),
              )
            )
              continue
            const endpointSegments = plan.planeEndpointSegments ?? []
            if (
              sourceSegments.some((s) =>
                endpointSegments.some(
                  (t) =>
                    s.layer === t.layer &&
                    distanceSegmentToSegment(s.start, s.end, t.start, t.end) <
                      EPSILON,
                ),
              )
            )
              continue
            plan = candidate
            working[index] = candidate
            escapes.set(plan.connectionIndex, {
              ...sourceEscape,
              segments: sourceSegments,
            })
            changedCornerCount++
            changed = true
            break
          }
        }
    }
    if (!changed) break
  }
  return {
    plans: working.filter((p) => supplied.has(p.connectionIndex)),
    sourceEscapes: params.sourceEscapes.map(
      (e) => escapes.get(e.connectionIndex)!,
    ),
    candidateCount,
    changedCornerCount,
  }
}
function validShape(segments: readonly RoutedSegment[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    const dx = s.end.x - s.start.x
    const dy = s.end.y - s.start.y
    const length = Math.hypot(dx, dy)
    if (
      length < EPSILON ||
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ) > EPSILON
    )
      return false
    if (i) {
      const p = segments[i - 1]
      const px = p.end.x - p.start.x
      const py = p.end.y - p.start.y
      if (distance(p.end, s.start) > EPSILON) return false
      if (
        p.layer === s.layer &&
        (px * dx + py * dy) / (Math.hypot(px, py) * length) <
          Math.SQRT1_2 - EPSILON
      )
        return false
    }
    for (let j = 0; j < i - 1; j++) {
      const p = segments[j]
      if (
        p.layer === s.layer &&
        distanceSegmentToSegment(p.start, p.end, s.start, s.end) < EPSILON
      )
        return false
    }
  }
  return true
}
