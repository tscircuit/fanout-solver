import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import {
  fanoutPlansAreClear,
  fanoutPlansAreMutuallyClear,
  type RouteBusParams,
} from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type { FanoutRoutePlan, PreparedBus, RoutedSegment } from "./types"

const EPSILON = 1e-7

export interface ShortenSourceCornersParams
  extends Pick<
    RouteBusParams,
    | "srj"
    | "layerNames"
    | "traceWidth"
    | "clearance"
    | "allowBlindAndBuriedVias"
    | "allowSameNetMerges"
  > {
  /** Every completed route whose copper must remain reserved. */
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  /** Missing completed routes are represented by virtual source-only plans. */
  sourceEscapes: readonly PeripheralSourceEscape[]
  maximumRounds?: number
  maximumCandidates?: number
  /** When supplied, only listed routes may shorten, and never below their floor. */
  minimumRetainedLengthByConnectionIndex?: ReadonlyMap<number, number>
}

export interface ShortenSourceCornersResult {
  plans: FanoutRoutePlan[]
  sourceEscapes: PeripheralSourceEscape[]
  candidateCount: number
  changedCornerCount: number
}

function rebuildSourcePrefix(
  plan: FanoutRoutePlan,
  segments: RoutedSegment[],
  count: number,
): FanoutRoutePlan | null {
  const via = plan.via
  if (!via) return null
  const viaIndex = plan.trace.route.findIndex(
    (point) => point.route_type === "via",
  )
  const viaPoint = plan.trace.route[viaIndex]
  const firstWire = plan.trace.route[0]
  const lastSourceWire = plan.trace.route[viaIndex - 1]
  if (
    viaPoint?.route_type !== "via" ||
    firstWire?.route_type !== "wire" ||
    lastSourceWire?.route_type !== "wire" ||
    distance(viaPoint, via.center) > EPSILON ||
    viaPoint.from_layer !== plan.sourceLayer ||
    distance(segments[count - 1].end, via.center) > EPSILON
  ) {
    return null
  }
  // Keep the emitted suffix verbatim, including terminal vias in source-only
  // plans, bridge transitions, and endpoint wire metadata.
  const route: FanoutRoutePlan["trace"]["route"] = [
    {
      ...firstWire,
      x: segments[0].start.x,
      y: segments[0].start.y,
      layer: segments[0].layer,
      width: segments[0].width,
      route_type: "wire",
    },
    ...segments.slice(0, count).map((segment, index) => ({
      ...(index === count - 1 ? lastSourceWire : {}),
      route_type: "wire" as const,
      ...segment.end,
      width: segment.width,
      layer: segment.layer,
    })),
    ...plan.trace.route.slice(viaIndex),
  ]
  return {
    ...plan,
    segments,
    length: [...segments, ...(plan.planeEndpointSegments ?? [])].reduce(
      (sum, segment) => sum + distance(segment.start, segment.end),
      0,
    ),
    trace: { ...plan.trace, route },
  }
}

function hasSelfContact(segments: readonly RoutedSegment[]): boolean {
  for (let first = 0; first < segments.length; first++) {
    for (let second = first + 2; second < segments.length; second++) {
      const a = segments[first]
      const b = segments[second]
      if (
        a.layer === b.layer &&
        distanceSegmentToSegment(a.start, a.end, b.start, b.end) < EPSILON
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Shorten existing axis/45-degree/axis source corners without moving a source
 * or first via. This is a geometry pass; callers perform bus length matching
 * afterward. Inputs are never mutated, and every accepted edit reserves all
 * completed copper plus every otherwise-unrouted source escape.
 */
export function shortenSourceEscapeCorners(
  params: ShortenSourceCornersParams,
): ShortenSourceCornersResult {
  const maximumRounds = params.maximumRounds ?? 12
  const maximumCandidates = params.maximumCandidates ?? 8192
  if (
    !Number.isInteger(maximumRounds) ||
    maximumRounds < 1 ||
    !Number.isInteger(maximumCandidates) ||
    maximumCandidates < 1 ||
    !Number.isFinite(params.traceWidth) ||
    params.traceWidth <= 0
  ) {
    throw new Error(
      "Source corner shortening requires positive search limits and width",
    )
  }
  if (
    params.minimumRetainedLengthByConnectionIndex &&
    [...params.minimumRetainedLengthByConnectionIndex.values()].some(
      (length) => !Number.isFinite(length) || length < 0,
    )
  )
    throw new Error(
      "Source shortening length floors must be finite and nonnegative",
    )
  const prepared = new Map(
    params.preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const sources = new Map(
    params.sourceEscapes.map((sourceEscape) => [
      sourceEscape.connectionIndex,
      sourceEscape,
    ]),
  )
  const suppliedIds = new Set(params.plans.map((plan) => plan.connectionIndex))
  if (
    sources.size !== params.sourceEscapes.length ||
    suppliedIds.size !== params.plans.length
  ) {
    throw new Error(
      "Source corner shortening requires unique connection identities",
    )
  }
  let working = [...params.plans]
  for (const sourceEscape of params.sourceEscapes) {
    const holder = prepared.get(sourceEscape.connectionIndex)
    if (!holder || sourceEscape.segments.length === 0) {
      throw new Error(
        "Source corner shortening requires prepared source escapes",
      )
    }
    if (
      sourceEscape.connectionName !== holder.connection.connection.name ||
      distance(sourceEscape.segments[0].start, holder.connection.sourcePoint) >
        EPSILON ||
      distance(sourceEscape.segments.at(-1)!.end, sourceEscape.via.center) >
        EPSILON
    )
      throw new Error(
        "Source corner shortening requires original source identities",
      )
    if (suppliedIds.has(sourceEscape.connectionIndex)) continue
    const plan = buildViaMinimalWindingPlan({
      bus: {
        ...holder.bus,
        termination: { type: "plane", layer: sourceEscape.via.toLayer },
      },
      terminal: {
        connection: holder.connection,
        viaPoint: sourceEscape.via.center,
        exitPoint: sourceEscape.via.center,
      },
      targetLayer: sourceEscape.via.toLayer,
      targetLayerPoints: [sourceEscape.via.center],
      sourceEscapePoints: [
        sourceEscape.segments[0].start,
        ...sourceEscape.segments.map((segment) => segment.end),
      ],
      layerNames: params.layerNames,
      traceWidth: params.traceWidth,
      viaDiameter: sourceEscape.via.diameter,
      viaHoleDiameter: sourceEscape.via.holeDiameter,
      allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
    })
    working.push({
      ...plan,
      via: sourceEscape.via,
      sourceEscapeSegmentCount: sourceEscape.segments.length,
    })
  }
  const boundary = params.preparedBuses[0]?.sharedBoundary
  let candidateCount = 0
  let changedCornerCount = 0
  const result = (): ShortenSourceCornersResult => ({
    plans: working.filter((plan) => suppliedIds.has(plan.connectionIndex)),
    sourceEscapes: params.sourceEscapes.map(
      (sourceEscape) => sources.get(sourceEscape.connectionIndex)!,
    ),
    candidateCount,
    changedCornerCount,
  })
  if (!boundary) {
    if (working.length)
      throw new Error("Source corner shortening requires a shared boundary")
    return result()
  }
  if (
    params.preparedBuses.some(
      (bus) =>
        bus.sharedBoundary.minX !== boundary.minX ||
        bus.sharedBoundary.maxX !== boundary.maxX ||
        bus.sharedBoundary.minY !== boundary.minY ||
        bus.sharedBoundary.maxY !== boundary.maxY,
    )
  )
    throw new Error("Source corner shortening requires one shared boundary")
  const clear = (plans: readonly FanoutRoutePlan[]) =>
    fanoutPlansAreClear({ ...params, plans, sharedBoundary: boundary })
  if (!clear(working))
    throw new Error("Source corner shortening requires clear input copper")
  for (const plan of working) {
    const sourceEscape = sources.get(plan.connectionIndex)
    if (!sourceEscape) continue
    const count = plan.sourceEscapeSegmentCount ?? 1
    if (
      count !== sourceEscape.segments.length ||
      count > plan.segments.length ||
      !plan.via ||
      distance(plan.via.center, sourceEscape.via.center) > EPSILON ||
      plan.segments.slice(0, count).some((segment, index) => {
        const sourceSegment = sourceEscape.segments[index]
        return (
          segment.layer !== plan.sourceLayer ||
          segment.layer !== sourceSegment.layer ||
          Math.abs(segment.width - sourceSegment.width) > EPSILON ||
          distance(segment.start, sourceSegment.start) > EPSILON ||
          distance(segment.end, sourceSegment.end) > EPSILON
        )
      })
    ) {
      throw new Error(
        "Source corner shortening requires matching source prefixes",
      )
    }
  }
  for (let round = 0; round < maximumRounds; round++) {
    let moved = false
    for (let planIndex = 0; planIndex < working.length; planIndex++) {
      let plan = working[planIndex]
      const holder = prepared.get(plan.connectionIndex)
      const sourceEscape = sources.get(plan.connectionIndex)
      const count = plan.sourceEscapeSegmentCount ?? 1
      const minimumLength = params.minimumRetainedLengthByConnectionIndex?.get(
        plan.connectionIndex,
      )
      if (
        (params.minimumRetainedLengthByConnectionIndex &&
          (minimumLength === undefined ||
            plan.length <= minimumLength + EPSILON)) ||
        !holder ||
        !sourceEscape ||
        holder.bus.maxLengthSkew === undefined ||
        count < 3
      )
        continue
      for (let middle = 1; middle < count - 1; middle++) {
        const a = plan.segments[middle - 1]
        const b = plan.segments[middle]
        const c = plan.segments[middle + 1]
        const lenA = distance(a.start, a.end)
        const lenC = distance(c.start, c.end)
        const dx = b.end.x - b.start.x
        const dy = b.end.y - b.start.y
        if (
          lenA <= params.traceWidth ||
          lenC <= params.traceWidth ||
          a.layer !== plan.sourceLayer ||
          b.layer !== plan.sourceLayer ||
          c.layer !== plan.sourceLayer ||
          Math.abs(Math.abs(dx) - Math.abs(dy)) > EPSILON ||
          Math.abs(dx) < EPSILON
        )
          continue
        const u = {
          x: (a.end.x - a.start.x) / lenA,
          y: (a.end.y - a.start.y) / lenA,
        }
        const v = {
          x: (c.end.x - c.start.x) / lenC,
          y: (c.end.y - c.start.y) / lenC,
        }
        if (
          Math.abs(u.x * v.x + u.y * v.y) > EPSILON ||
          Math.min(Math.abs(u.x), Math.abs(u.y)) > EPSILON ||
          Math.min(Math.abs(v.x), Math.abs(v.y)) > EPSILON ||
          dx * u.x + dy * u.y <= 0 ||
          dx * v.x + dy * v.y <= 0
        )
          continue
        const steps = Math.floor(
          (Math.min(lenA, lenC) - params.traceWidth + EPSILON) /
            params.traceWidth,
        )
        for (let step = steps; step >= 1; step--) {
          if (candidateCount === maximumCandidates) return result()
          candidateCount++
          const increment = step * params.traceWidth
          const start = {
            x: b.start.x - u.x * increment,
            y: b.start.y - u.y * increment,
          }
          const end = {
            x: b.end.x + v.x * increment,
            y: b.end.y + v.y * increment,
          }
          const segments = plan.segments.map((segment, index) =>
            index === middle - 1
              ? { ...segment, end: start }
              : index === middle
                ? { ...segment, start, end }
                : index === middle + 1
                  ? { ...segment, start: end }
                  : segment,
          )
          if (hasSelfContact(segments)) continue
          const changedPrefix = segments.slice(middle - 1, middle + 2)
          const otherVias = [
            ...(plan.additionalVias ?? []),
            ...(plan.planeEndpointVia ? [plan.planeEndpointVia] : []),
          ]
          if (
            changedPrefix.some(
              (segment) =>
                (plan.planeEndpointSegments ?? []).some(
                  (endpoint) =>
                    segment.layer === endpoint.layer &&
                    distanceSegmentToSegment(
                      segment.start,
                      segment.end,
                      endpoint.start,
                      endpoint.end,
                    ) < EPSILON,
                ) ||
                otherVias.some(
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
          const candidate = rebuildSourcePrefix(plan, segments, count)
          if (
            !candidate ||
            candidate.length >= plan.length - EPSILON ||
            (minimumLength !== undefined &&
              candidate.length < minimumLength - EPSILON)
          )
            continue
          const next = working.map((current, index) =>
            index === planIndex ? candidate : current,
          )
          // The current set is already clear. Only this replacement can
          // introduce a new violation, so keep every unchanged pair cached
          // implicitly by checking the candidate against each other plan.
          if (
            !clear([candidate]) ||
            working.some(
              (other, index) =>
                index !== planIndex &&
                !fanoutPlansAreMutuallyClear({
                  ...params,
                  plans: [candidate, other],
                }),
            )
          )
            continue
          working = next
          plan = candidate
          sources.set(plan.connectionIndex, {
            ...sources.get(plan.connectionIndex)!,
            segments: segments.slice(0, count),
          })
          changedCornerCount++
          moved = true
          break
        }
      }
    }
    if (!moved) break
  }
  return result()
}
