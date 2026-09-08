import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
  segmentsAreClear,
} from "./geometry"
import {
  type DeclaredDifferentialPair,
  getDeclaredDifferentialPairs,
} from "./get-declared-differential-pairs"
import { getCopperLayerNames } from "./layer-names"
import { rematchUnroutedSourceDogbones } from "./rematch-unrouted-source-dogbones"
import {
  createFanoutPlanClearanceValidator,
  fanoutPlansAreMutuallyClear,
} from "./route-bus"
import { routeViaMinimalWinding } from "./route-via-minimal-winding"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  RoutedSegment,
  RoutedVia,
} from "./types"

const EPSILON = 1e-6

function pointsMatch(first: Point2D, second: Point2D): boolean {
  return distance(first, second) <= EPSILON
}

function getPlanVias(plan: FanoutRoutePlan): RoutedVia[] {
  return [plan.via, ...(plan.additionalVias ?? [])].filter(
    (via): via is RoutedVia => via !== undefined,
  )
}

function rebuildTraceRoute(
  plan: FanoutRoutePlan,
  segments: readonly RoutedSegment[],
): SimplifiedPcbTrace["route"] | null {
  const firstSegment = segments[0]
  if (!firstSegment) return null
  const firstOriginalWire = plan.trace.route.find(
    (point) => point.route_type === "wire",
  )
  const lastOriginalWire = plan.trace.route.findLast(
    (point) => point.route_type === "wire",
  )
  const getWireMetadata = (
    wire: typeof firstOriginalWire,
  ): Partial<
    Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
  > => {
    if (wire?.route_type !== "wire") return {}
    const metadata: Partial<
      Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
    > = { ...wire }
    delete metadata.route_type
    delete metadata.x
    delete metadata.y
    delete metadata.width
    delete metadata.layer
    return metadata
  }
  const vias = getPlanVias(plan)
  const startsWithSourceVia =
    pointsMatch(firstSegment.start, plan.sourcePoint) &&
    firstSegment.layer !== plan.sourceLayer &&
    vias.some(
      (via) =>
        pointsMatch(via.center, firstSegment.start) &&
        via.spanLayers.includes(plan.sourceLayer) &&
        via.spanLayers.includes(firstSegment.layer),
    )
  const initialLayer = startsWithSourceVia
    ? plan.sourceLayer
    : firstSegment.layer
  const route: SimplifiedPcbTrace["route"] = [
    {
      ...getWireMetadata(firstOriginalWire),
      route_type: "wire",
      ...firstSegment.start,
      width: firstSegment.width,
      layer: initialLayer,
    },
  ]
  let currentPoint = firstSegment.start
  let currentLayer = initialLayer

  for (const [segmentIndex, segment] of segments.entries()) {
    if (!pointsMatch(currentPoint, segment.start)) return null
    if (currentLayer !== segment.layer) {
      const transitionVia = vias.find(
        (via) =>
          pointsMatch(via.center, segment.start) &&
          via.spanLayers.includes(currentLayer) &&
          via.spanLayers.includes(segment.layer),
      )
      if (!transitionVia) return null
      route.push({
        route_type: "via",
        ...segment.start,
        from_layer: currentLayer,
        to_layer: segment.layer,
        via_diameter: transitionVia.diameter,
        via_hole_diameter: transitionVia.holeDiameter,
      })
      route.push({
        route_type: "wire",
        ...segment.start,
        width: segment.width,
        layer: segment.layer,
      })
      currentLayer = segment.layer
    }
    route.push({
      ...(segmentIndex === segments.length - 1
        ? getWireMetadata(lastOriginalWire)
        : {}),
      route_type: "wire",
      ...segment.end,
      width: segment.width,
      layer: segment.layer,
    })
    currentPoint = segment.end
  }
  return route
}

function createPlanWithSegments(
  plan: FanoutRoutePlan,
  segments: RoutedSegment[],
  updateSourceEscapeCount = false,
): FanoutRoutePlan | null {
  const route = rebuildTraceRoute(plan, segments)
  if (!route) return null
  const length = [...segments, ...(plan.planeEndpointSegments ?? [])].reduce(
    (total, segment) => total + distance(segment.start, segment.end),
    0,
  )
  const sourceEscapeSegmentCount = segments.findIndex(
    (s) => s.layer !== plan.sourceLayer,
  )
  return {
    ...plan,
    ...(updateSourceEscapeCount &&
    plan.sourceEscapeSegmentCount !== undefined &&
    sourceEscapeSegmentCount >= 0
      ? { sourceEscapeSegmentCount }
      : {}),
    trace: { ...plan.trace, route },
    segments,
    length,
  }
}

/** New barrels must not bypass an earlier or later part of their own route. */
export function addedTuningViasAreSelfClear(
  plan: FanoutRoutePlan,
  addedVias: readonly RoutedVia[],
  clearance: number,
): boolean {
  const vias = [
    ...getPlanVias(plan),
    ...(plan.planeEndpointVia ? [plan.planeEndpointVia] : []),
  ]
  for (const via of addedVias) {
    for (const other of vias) {
      if (other === via) continue
      if (
        via.spanLayers.some((layer) => other.spanLayers.includes(layer)) &&
        distance(via.center, other.center) <
          (via.diameter + other.diameter) / 2 + clearance - 1e-9
      )
        return false
    }
    // Only the actual transition in the ordered path joins this barrel. A
    // distant same-net segment at the same coordinate is still a shortcut.
    const transitions = plan.segments.flatMap((segment, index) => {
      const next = plan.segments[index + 1]
      return segment.layer === via.fromLayer &&
        next?.layer === via.toLayer &&
        pointsMatch(segment.end, via.center) &&
        pointsMatch(next.start, via.center)
        ? [index]
        : []
    })
    if (transitions.length !== 1) return false
    const incident = new Set<number>()
    // Short chamfered leads can join a via through several segments. Bound
    // that exemption by distance along its actual lead, never by proximity
    // alone, which would also exempt a distant returning arm of the trace.
    for (const direction of [-1, 1] as const) {
      let point = via.center
      let pathDistance = 0
      const layer = direction === -1 ? via.fromLayer : via.toLayer
      for (
        let index = transitions[0]! + (direction === 1 ? 1 : 0);
        index >= 0 && index < plan.segments.length;
        index += direction
      ) {
        const segment = plan.segments[index]!
        const near = direction === -1 ? segment.end : segment.start
        const far = direction === -1 ? segment.start : segment.end
        const radius = (via.diameter + segment.width) / 2 + clearance
        if (
          segment.layer !== layer ||
          !pointsMatch(point, near) ||
          pathDistance > radius + EPSILON
        )
          break
        incident.add(index)
        pathDistance += distance(near, far)
        point = far
      }
    }
    for (const [index, segment] of [
      ...plan.segments,
      ...(plan.planeEndpointSegments ?? []),
    ].entries()) {
      if (incident.has(index) || !via.spanLayers.includes(segment.layer))
        continue
      if (
        distancePointToSegment(via.center, segment.start, segment.end) <
        (via.diameter + segment.width) / 2 + clearance - 1e-9
      )
        return false
    }
  }
  return true
}

/** Open a tuning window on another permitted layer without moving either endpoint. */
function* createTransitTuningBases(params: {
  plan: FanoutRoutePlan
  bus: PreparedBus
  layerNames: string[]
  clearance: number
  workBudget?: MatchingWorkBudget
}): Generator<{
  plan: FanoutRoutePlan
  tuningLayer: string
  addedVias: RoutedVia[]
}> {
  const { plan, bus, layerNames, clearance, workBudget } = params
  if (!plan.via || getPlanVias(plan).length > 5) return
  const allowed = bus.allowedLayers ?? layerNames
  const layers = (bus.routableEscapeLayers ?? allowed).filter(
    (layer) =>
      allowed.includes(layer) &&
      layerNames.includes(layer) &&
      layer !== plan.sourceLayer &&
      layer !== plan.targetLayer,
  )
  const compact: RoutedSegment[] = []
  for (const segment of plan.segments) {
    const previous = compact.at(-1)
    if (
      previous?.layer === segment.layer &&
      segment.layer === plan.targetLayer
    ) {
      const ax = previous.end.x - previous.start.x
      const ay = previous.end.y - previous.start.y
      const bx = segment.end.x - segment.start.x
      const by = segment.end.y - segment.start.y
      if (
        Math.abs(ax * by - ay * bx) <=
          EPSILON * Math.hypot(ax, ay) * Math.hypot(bx, by) &&
        ax * bx + ay * by > 0
      ) {
        previous.end = segment.end
        continue
      }
    }
    compact.push({ ...segment })
  }
  const original = createPlanWithSegments(plan, compact)
  if (!original) return
  const newVia = (
    center: Point2D,
    fromLayer: string,
    toLayer: string,
  ): RoutedVia => ({
    center,
    fromLayer,
    toLayer,
    diameter: plan.via!.diameter,
    holeDiameter: plan.via!.holeDiameter,
    spanLayers: layerNames,
  })
  for (const tuningLayer of layers) {
    for (const reuseFirst of [true, false]) {
      if (
        reuseFirst &&
        (original.additionalVias?.length ||
          original.via!.toLayer !== original.targetLayer)
      )
        continue
      for (const [index, segment] of original.segments.entries()) {
        if (segment.layer !== original.targetLayer) continue
        if (distance(segment.start, segment.end) <= EPSILON) continue
        for (let step = 0; step < 37; step++) {
          const fraction = 0.05 + step * 0.025
          if (!reuseFirst && fraction >= 0.5) break
          consumeMatchingWork(workBudget)
          const point = (t: number): Point2D => ({
            x: segment.start.x + (segment.end.x - segment.start.x) * t,
            y: segment.start.y + (segment.end.y - segment.start.y) * t,
          })
          const first = point(fraction),
            last = point(1 - fraction)
          if (
            !reuseFirst &&
            distance(first, last) < plan.via.diameter + clearance
          )
            continue
          const addedVias = reuseFirst
            ? [newVia(last, tuningLayer, segment.layer)]
            : [
                newVia(first, segment.layer, tuningLayer),
                newVia(last, tuningLayer, segment.layer),
              ]
          const base = reuseFirst
            ? createPlanWithSegments(
                {
                  ...original,
                  via: { ...original.via!, toLayer: tuningLayer },
                  additionalVias: addedVias,
                },
                [
                  ...original.segments
                    .slice(0, index)
                    .map((s) =>
                      s.layer === original.targetLayer
                        ? { ...s, layer: tuningLayer }
                        : s,
                    ),
                  { ...segment, end: last, layer: tuningLayer },
                  { ...segment, start: last },
                  ...original.segments.slice(index + 1),
                ],
              )
            : createPlanWithSegments(
                {
                  ...original,
                  additionalVias: [
                    ...(original.additionalVias ?? []),
                    ...addedVias,
                  ],
                },
                [
                  ...original.segments.slice(0, index),
                  { ...segment, end: first },
                  { ...segment, start: first, end: last, layer: tuningLayer },
                  { ...segment, start: last },
                  ...original.segments.slice(index + 1),
                ],
              )
          if (base && addedTuningViasAreSelfClear(base, addedVias, clearance))
            yield { plan: base, tuningLayer, addedVias }
        }
      }
    }
  }
}

function pointIsOutsideDenseBounds(
  point: Point2D,
  bounds: Bounds,
  margin: number,
): boolean {
  return (
    point.x < bounds.minX - margin ||
    point.x > bounds.maxX + margin ||
    point.y < bounds.minY - margin ||
    point.y > bounds.maxY + margin
  )
}

function splitSegmentAtDenseBounds(params: {
  segment: RoutedSegment
  bounds: Bounds
  margin: number
}): RoutedSegment[] {
  const { segment, bounds, margin } = params
  const expandedBounds = {
    minX: bounds.minX - margin,
    maxX: bounds.maxX + margin,
    minY: bounds.minY - margin,
    maxY: bounds.maxY + margin,
  }
  const deltaX = segment.end.x - segment.start.x
  const deltaY = segment.end.y - segment.start.y
  const splitParameters = [0, 1]
  const addSplitParameter = (parameter: number): void => {
    if (parameter <= EPSILON || parameter >= 1 - EPSILON) return
    const point = {
      x: segment.start.x + deltaX * parameter,
      y: segment.start.y + deltaY * parameter,
    }
    if (
      point.x < expandedBounds.minX - EPSILON ||
      point.x > expandedBounds.maxX + EPSILON ||
      point.y < expandedBounds.minY - EPSILON ||
      point.y > expandedBounds.maxY + EPSILON
    ) {
      return
    }
    splitParameters.push(parameter)
  }
  if (Math.abs(deltaX) > EPSILON) {
    addSplitParameter((expandedBounds.minX - segment.start.x) / deltaX)
    addSplitParameter((expandedBounds.maxX - segment.start.x) / deltaX)
  }
  if (Math.abs(deltaY) > EPSILON) {
    addSplitParameter((expandedBounds.minY - segment.start.y) / deltaY)
    addSplitParameter((expandedBounds.maxY - segment.start.y) / deltaY)
  }
  const parameters = splitParameters
    .toSorted((first, second) => first - second)
    .filter(
      (parameter, index, values) =>
        index === 0 || Math.abs(parameter - values[index - 1]!) > EPSILON,
    )
  return parameters.slice(1).map((endParameter, index) => {
    const startParameter = parameters[index]!
    return {
      ...segment,
      start: {
        x: segment.start.x + deltaX * startParameter,
        y: segment.start.y + deltaY * startParameter,
      },
      end: {
        x: segment.start.x + deltaX * endParameter,
        y: segment.start.y + deltaY * endParameter,
      },
    }
  })
}

function getDenseCopperBounds(bus: PreparedBus): Bounds {
  return bus.componentObstacles.reduce<Bounds>(
    (bounds, obstacle) => ({
      minX: Math.min(bounds.minX, obstacle.center.x - obstacle.width / 2),
      maxX: Math.max(bounds.maxX, obstacle.center.x + obstacle.width / 2),
      minY: Math.min(bounds.minY, obstacle.center.y - obstacle.height / 2),
      maxY: Math.max(bounds.maxY, obstacle.center.y + obstacle.height / 2),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  )
}

function segmentsIntersect(
  first: RoutedSegment,
  second: RoutedSegment,
): boolean {
  if (first.layer !== second.layer) return false
  if (
    Math.min(first.start.x, first.end.x) >
      Math.max(second.start.x, second.end.x) + EPSILON ||
    Math.min(second.start.x, second.end.x) >
      Math.max(first.start.x, first.end.x) + EPSILON ||
    Math.min(first.start.y, first.end.y) >
      Math.max(second.start.y, second.end.y) + EPSILON ||
    Math.min(second.start.y, second.end.y) >
      Math.max(first.start.y, first.end.y) + EPSILON
  )
    return false
  return (
    distanceSegmentToSegment(
      first.start,
      first.end,
      second.start,
      second.end,
    ) <= EPSILON
  )
}

/** Cache unchanged geometry while replacing exactly one original segment. */
function createReplacementSelfIntersectionChecker(
  original: readonly RoutedSegment[],
): (
  segments: readonly RoutedSegment[],
  replacementStartIndex: number,
  replacementSegmentCount: number,
) => boolean {
  let originalIntersections: [number, number][] | undefined
  return (segments, replacementStartIndex, replacementSegmentCount) => {
    // Generators can reject every placement before reaching this check.
    // Avoid scanning their retained path until a candidate actually needs it.
    if (!originalIntersections) {
      originalIntersections = []
      for (let first = 0; first < original.length; first++)
        for (let second = first + 2; second < original.length; second++)
          if (segmentsIntersect(original[first]!, original[second]!))
            originalIntersections.push([first, second])
    }
    const replacementEndIndex =
      replacementStartIndex + replacementSegmentCount - 1
    const hasAdjacencyExemption = (first: number, second: number) =>
      second === first + 2 &&
      pointsMatch(segments[first]!.end, segments[second]!.start)
    for (const [first, second] of originalIntersections) {
      if (first === replacementStartIndex || second === replacementStartIndex)
        continue
      const shiftedFirst =
          first > replacementStartIndex
            ? first + replacementSegmentCount - 1
            : first,
        shiftedSecond =
          second > replacementStartIndex
            ? second + replacementSegmentCount - 1
            : second
      // Reapply the original index-based exemption after the replacement has
      // shifted the untouched segments. No pre-existing crossing is ignored.
      if (!hasAdjacencyExemption(shiftedFirst, shiftedSecond)) return true
    }
    for (
      let replacement = replacementStartIndex;
      replacement <= replacementEndIndex;
      replacement++
    )
      for (let other = 0; other < segments.length; other++) {
        if (Math.abs(replacement - other) < 2) continue
        if (other >= replacementStartIndex && other < replacement) continue
        const first = Math.min(replacement, other),
          second = Math.max(replacement, other)
        if (hasAdjacencyExemption(first, second)) continue
        if (segmentsIntersect(segments[first]!, segments[second]!)) return true
      }
    return false
  }
}

export function replacementCopperIsSelfClear(params: {
  plan: FanoutRoutePlan
  segments: readonly RoutedSegment[]
  replacementStartIndex: number
  replacementSegmentCount: number
  clearance: number
}): boolean {
  const {
    plan,
    segments,
    replacementStartIndex,
    replacementSegmentCount,
    clearance,
  } = params
  const replacementEndIndex =
    replacementStartIndex + replacementSegmentCount - 1
  const vias = getPlanVias(plan)
  // A candidate preserves a connected path except at layer changes. Prefix
  // lengths make each local-adjacency exemption constant time even when a
  // negotiated route contains hundreds of short chamfered segments.
  const pathGroups = new Int32Array(segments.length)
  const pathLengths = new Float64Array(segments.length + 1)
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!,
      previous = segments[index - 1]
    pathGroups[index] =
      index === 0
        ? 0
        : pathGroups[index - 1]! +
          Number(
            previous!.layer !== segment.layer ||
              !pointsMatch(previous!.end, segment.start),
          )
    pathLengths[index + 1] =
      pathLengths[index]! + distance(segment.start, segment.end)
  }
  const getConnectedPathDistance = (
    firstIndex: number,
    secondIndex: number,
  ): number => {
    if (firstIndex === secondIndex) return 0
    if (pathGroups[firstIndex] !== pathGroups[secondIndex])
      return Number.POSITIVE_INFINITY
    const startIndex = Math.min(firstIndex, secondIndex)
    const endIndex = Math.max(firstIndex, secondIndex)
    return Math.max(0, pathLengths[endIndex]! - pathLengths[startIndex + 1]!)
  }
  for (
    let replacementIndex = replacementStartIndex;
    replacementIndex <= replacementEndIndex;
    replacementIndex++
  ) {
    const replacement = segments[replacementIndex]!
    const original = plan.segments[replacementStartIndex]!
    // Leading/trailing pieces retained on the original straight segment do not
    // introduce copper. Their proximity to an unchanged chamfered continuation
    // must not reject a distant meander. Every genuinely new piece still checks
    // every retained and new segment below, including these retained leads.
    if (
      replacement.layer === original.layer &&
      replacement.width === original.width &&
      distancePointToSegment(replacement.start, original.start, original.end) <=
        EPSILON &&
      distancePointToSegment(replacement.end, original.start, original.end) <=
        EPSILON
    )
      continue
    for (const [otherIndex, other] of segments.entries()) {
      const requiredCenterlineClearance =
        replacement.width / 2 + other.width / 2 + clearance
      if (
        getConnectedPathDistance(replacementIndex, otherIndex) <=
        requiredCenterlineClearance + EPSILON
      ) {
        continue
      }
      if (!segmentsAreClear(replacement, other, clearance)) return false
    }
    for (const via of vias) {
      if (!via.spanLayers.includes(replacement.layer)) continue
      if (
        pointsMatch(via.center, replacement.start) ||
        pointsMatch(via.center, replacement.end)
      ) {
        continue
      }
      const viaClearance = via.diameter / 2 + replacement.width / 2 + clearance
      // An off-grid via can join this run through a short, connected stub.
      // Preserve that existing connection while rejecting later approaches.
      const connectsThroughShortStub = (direction: -1 | 1): boolean => {
        let point = direction === -1 ? replacement.start : replacement.end
        let pathDistance = 0
        for (
          let index = replacementIndex + direction;
          index >= 0 && index < segments.length;
          index += direction
        ) {
          const segment = segments[index]!
          if (segment.layer !== replacement.layer) return false
          const connectedEnd = direction === -1 ? segment.end : segment.start
          if (!pointsMatch(point, connectedEnd)) return false
          pathDistance += distance(segment.start, segment.end)
          if (pathDistance > viaClearance + EPSILON) return false
          point = direction === -1 ? segment.start : segment.end
          if (pointsMatch(point, via.center)) return true
        }
        return false
      }
      if (
        distancePointToSegment(via.center, replacement.start, replacement.end) <
          viaClearance - EPSILON &&
        !connectsThroughShortStub(-1) &&
        !connectsThroughShortStub(1)
      ) {
        return false
      }
    }
  }
  return true
}

function pointIsInsideBounds(point: Point2D, bounds: Bounds): boolean {
  return (
    point.x >= bounds.minX - EPSILON &&
    point.x <= bounds.maxX + EPSILON &&
    point.y >= bounds.minY - EPSILON &&
    point.y <= bounds.maxY + EPSILON
  )
}

function addScaled(point: Point2D, vector: Point2D, scale: number): Point2D {
  return {
    x: point.x + vector.x * scale,
    y: point.y + vector.y * scale,
  }
}

function createMeanderPoints(params: {
  segment: RoutedSegment
  toothCount: number
  targetAddedLength: number
  pitch: number
  placementFraction: number
  normalSign: -1 | 1
}): Point2D[] | null {
  const {
    segment,
    toothCount,
    targetAddedLength,
    pitch,
    placementFraction,
    normalSign,
  } = params
  const dx = segment.end.x - segment.start.x
  const dy = segment.end.y - segment.start.y
  const segmentLength = Math.hypot(dx, dy)
  if (segmentLength <= EPSILON) return null
  const isAxisAligned = Math.abs(dx) <= EPSILON || Math.abs(dy) <= EPSILON
  const isFortyFiveDegree = Math.abs(Math.abs(dx) - Math.abs(dy)) <= EPSILON
  if (!isAxisAligned && !isFortyFiveDegree) return null
  const tangent = { x: dx / segmentLength, y: dy / segmentLength }
  const normal = {
    x: -tangent.y * normalSign,
    y: tangent.x * normalSign,
  }
  const chamfer = Math.min(
    pitch / 2,
    targetAddedLength / (8 * toothCount * (Math.SQRT2 - 1)),
  )
  const plateau = pitch
  const toothSpan = chamfer * 4 + plateau
  const toothGap = pitch
  const occupiedLength =
    toothCount * toothSpan + Math.max(0, toothCount - 1) * toothGap
  const minimumLead = pitch / 4
  if (occupiedLength + minimumLead * 2 > segmentLength + EPSILON) {
    return null
  }
  const minimumAddedLengthPerTooth = 4 * chamfer * (Math.SQRT2 - 1)
  if (targetAddedLength + EPSILON < minimumAddedLengthPerTooth * toothCount) {
    return null
  }
  const verticalRun =
    (targetAddedLength / toothCount - minimumAddedLengthPerTooth) / 2
  const movableLead = segmentLength - occupiedLength - minimumLead * 2
  const leadingLength =
    minimumLead + Math.max(0, movableLead) * placementFraction
  let cursor = addScaled(segment.start, tangent, leadingLength)
  const points: Point2D[] = [{ ...segment.start }, { ...cursor }]

  for (let toothIndex = 0; toothIndex < toothCount; toothIndex++) {
    cursor = addScaled(addScaled(cursor, tangent, chamfer), normal, chamfer)
    points.push(cursor)
    cursor = addScaled(cursor, normal, verticalRun)
    points.push(cursor)
    cursor = addScaled(addScaled(cursor, tangent, chamfer), normal, chamfer)
    points.push(cursor)
    cursor = addScaled(cursor, tangent, plateau)
    points.push(cursor)
    cursor = addScaled(addScaled(cursor, tangent, chamfer), normal, -chamfer)
    points.push(cursor)
    cursor = addScaled(cursor, normal, -verticalRun)
    points.push(cursor)
    cursor = addScaled(addScaled(cursor, tangent, chamfer), normal, -chamfer)
    points.push(cursor)
    if (toothIndex < toothCount - 1) {
      cursor = addScaled(cursor, tangent, toothGap)
      points.push(cursor)
    }
  }
  points.push({ ...segment.end })
  return points.filter(
    (point, index) => index === 0 || !pointsMatch(point, points[index - 1]!),
  )
}

interface MatchingWorkBudget {
  remaining: number
  activeBus?: PreparedBus
}

class MatchingWorkBudgetExhausted extends Error {}

function consumeMatchingWork(budget: MatchingWorkBudget | undefined): void {
  if (budget && budget.remaining-- <= 0) throw new MatchingWorkBudgetExhausted()
}

function* createTunedPlanCandidates(params: {
  plan: FanoutRoutePlan
  bus: PreparedBus
  targetAddedLength: number
  clearance: number
  sharedBoundary: Bounds
  allowInsideDenseBounds?: boolean
  allowSourcePrefixMatching?: boolean
  allowTransitLayerMatching?: boolean
  denseBoundarySplitApplied?: boolean
  workBudget?: MatchingWorkBudget
}): Generator<FanoutRoutePlan> {
  const {
    plan,
    bus,
    targetAddedLength,
    clearance,
    sharedBoundary,
    allowInsideDenseBounds = false,
    allowSourcePrefixMatching = false,
    denseBoundarySplitApplied = false,
  } = params
  const denseCopperBounds = getDenseCopperBounds(bus)
  const replacementHasSelfIntersection =
    createReplacementSelfIntersectionChecker(plan.segments)
  const denseMargin = plan.segments[0]?.width
    ? plan.segments[0].width / 2 + clearance
    : clearance
  const eligibleSegments = plan.segments
    .map((segment, segmentIndex) => ({ segment, segmentIndex }))
    .filter(
      ({ segment, segmentIndex }) =>
        segment.layer === plan.targetLayer ||
        (params.allowTransitLayerMatching &&
          segment.layer !== plan.sourceLayer &&
          (bus.allowedLayers ?? [plan.targetLayer]).includes(segment.layer) &&
          (
            bus.routableEscapeLayers ??
            bus.allowedLayers ?? [plan.targetLayer]
          ).includes(segment.layer)) ||
        (allowSourcePrefixMatching &&
          plan.via &&
          plan.sourceLayer !== plan.targetLayer &&
          segmentIndex > 0 &&
          segmentIndex < (plan.sourceEscapeSegmentCount ?? 1) &&
          segment.layer === plan.sourceLayer),
    )
    .toSorted(
      (first, second) =>
        distance(second.segment.start, second.segment.end) -
        distance(first.segment.start, first.segment.end),
    )

  for (const { segment, segmentIndex } of eligibleSegments) {
    const pitch = segment.width + clearance
    const segmentLength = distance(segment.start, segment.end)
    const maximumToothCount = Math.min(
      12,
      Math.max(0, Math.floor((segmentLength / pitch + 0.5) / 4)),
    )
    for (let toothCount = 1; toothCount <= maximumToothCount; toothCount++) {
      for (const placementFraction of [0.5, 0, 1, 0.25, 0.75]) {
        for (const normalSign of [1, -1] as const) {
          consumeMatchingWork(params.workBudget)
          const points = createMeanderPoints({
            segment,
            toothCount,
            targetAddedLength,
            pitch,
            placementFraction,
            normalSign,
          })
          if (!points) continue
          if (
            points.some((point) => !pointIsInsideBounds(point, sharedBoundary))
          ) {
            continue
          }
          if (
            !allowInsideDenseBounds &&
            points
              .slice(1, -1)
              .some(
                (point) =>
                  !pointIsOutsideDenseBounds(
                    point,
                    denseCopperBounds,
                    denseMargin,
                  ),
              )
          ) {
            continue
          }
          const replacementSegments = points.slice(1).map((end, index) => ({
            start: points[index]!,
            end,
            width: segment.width,
            layer: segment.layer,
          }))
          const segments = [
            ...plan.segments.slice(0, segmentIndex),
            ...replacementSegments,
            ...plan.segments.slice(segmentIndex + 1),
          ]
          if (
            segment.layer === plan.sourceLayer &&
            segment.layer !== plan.targetLayer &&
            replacementSegments.some(
              (s) =>
                distanceSegmentToObstacle(s, plan.sourceObstacle) <
                s.width / 2 + clearance - EPSILON,
            )
          )
            continue
          if (
            replacementHasSelfIntersection(
              segments,
              segmentIndex,
              replacementSegments.length,
            )
          )
            continue
          if (
            !replacementCopperIsSelfClear({
              plan,
              segments,
              replacementStartIndex: segmentIndex,
              replacementSegmentCount: replacementSegments.length,
              clearance,
            })
          ) {
            continue
          }
          const candidate = createPlanWithSegments(
            plan,
            segments,
            allowSourcePrefixMatching,
          )
          if (candidate) yield candidate
        }
      }
    }
  }
  if (denseBoundarySplitApplied) return
  const splitSegments = plan.segments.flatMap((segment, index) =>
    allowSourcePrefixMatching && index === 0
      ? [segment]
      : splitSegmentAtDenseBounds({
          segment,
          bounds: denseCopperBounds,
          margin: denseMargin,
        }),
  )
  const splitPlan = createPlanWithSegments(
    plan,
    splitSegments,
    allowSourcePrefixMatching,
  )
  if (!splitPlan) return
  yield* createTunedPlanCandidates({
    ...params,
    plan: splitPlan,
    denseBoundarySplitApplied: true,
  })
}

/** Move an existing fold between opposite straight legs without adding corners. */
function* createExtendedFoldCandidates(params: {
  plan: FanoutRoutePlan
  bus: PreparedBus
  targetAddedLength: number
  clearance: number
  allowInsideDenseBounds: boolean
  allowSourcePrefixMatching?: boolean
  allowTransitLayerMatching?: boolean
  workBudget?: MatchingWorkBudget
}): Generator<FanoutRoutePlan> {
  const { plan, bus, targetAddedLength, clearance } = params
  const denseBounds = getDenseCopperBounds(bus)
  for (let first = 0; first < plan.segments.length; first++) {
    const start = plan.segments[first]!
    const onSource =
      start.layer === plan.sourceLayer && start.layer !== plan.targetLayer
    if (onSource) {
      if (!params.allowSourcePrefixMatching || !plan.via || first === 0)
        continue
    } else if (
      start.layer !== plan.targetLayer &&
      (!params.allowTransitLayerMatching ||
        !(bus.allowedLayers ?? [plan.targetLayer]).includes(start.layer) ||
        !(
          bus.routableEscapeLayers ??
          bus.allowedLayers ?? [plan.targetLayer]
        ).includes(start.layer))
    )
      continue
    const length = distance(start.start, start.end)
    if (length <= EPSILON) continue
    const direction = {
      x: (start.end.x - start.start.x) / length,
      y: (start.end.y - start.start.y) / length,
    }
    for (
      let last = first + 2;
      last < Math.min(plan.segments.length, first + 16);
      last++
    ) {
      const span = plan.segments.slice(first, last + 1)
      if (span.some((segment) => segment.layer !== start.layer)) break
      const end = plan.segments[last]!,
        endLength = distance(end.start, end.end)
      if (endLength <= EPSILON) continue
      const reverse = {
        x: (end.end.x - end.start.x) / endLength,
        y: (end.end.y - end.start.y) / endLength,
      }
      if (
        Math.abs(direction.x + reverse.x) > EPSILON ||
        Math.abs(direction.y + reverse.y) > EPSILON
      )
        continue
      consumeMatchingWork(params.workBudget)
      const move = (point: Point2D): Point2D => ({
        ...point,
        x: point.x + (direction.x * targetAddedLength) / 2,
        y: point.y + (direction.y * targetAddedLength) / 2,
      })
      const segments = plan.segments.map((segment, index) =>
        index < first || index > last
          ? segment
          : index === first
            ? { ...segment, end: move(segment.end) }
            : index === last
              ? { ...segment, start: move(segment.start) }
              : {
                  ...segment,
                  start: move(segment.start),
                  end: move(segment.end),
                },
      )
      const changed = segments.slice(first, last + 1)
      if (
        changed.some((segment, offset) => {
          const index = first + offset
          return segments.some((other, otherIndex) => {
            if (Math.abs(index - otherIndex) < 2) return false
            const a = Math.min(index, otherIndex),
              b = Math.max(index, otherIndex)
            if (
              b === a + 2 &&
              pointsMatch(segments[a]!.end, segments[b]!.start)
            )
              return false
            return segmentsIntersect(segment, other)
          })
        })
      )
        continue
      if (
        changed.some((segment) =>
          [segment.start, segment.end].some(
            (point) =>
              !pointIsInsideBounds(point, bus.sharedBoundary) ||
              (!params.allowInsideDenseBounds &&
                !pointIsOutsideDenseBounds(
                  point,
                  denseBounds,
                  segment.width / 2 + clearance,
                )),
          ),
        )
      )
        continue
      if (
        onSource &&
        changed.some(
          (segment) =>
            distanceSegmentToObstacle(segment, plan.sourceObstacle) <
            segment.width / 2 + clearance - EPSILON,
        )
      )
        continue
      if (
        !replacementCopperIsSelfClear({
          plan,
          segments,
          replacementStartIndex: first,
          replacementSegmentCount: last - first + 1,
          clearance,
        })
      )
        continue
      const candidate = createPlanWithSegments(plan, segments)
      if (candidate) yield candidate
    }
  }
}

function getBusSkew(plans: readonly FanoutRoutePlan[]): number {
  const lengths = plans.map((plan) => plan.length)
  return Math.max(...lengths) - Math.min(...lengths)
}

function getPlansForIndices(
  plans: readonly FanoutRoutePlan[],
  indices: ReadonlySet<number>,
): FanoutRoutePlan[] {
  return plans.filter((plan) => indices.has(plan.connectionIndex))
}

function* createSpreadLaneCandidates(
  plan: FanoutRoutePlan,
  clearance: number,
  workBudget?: MatchingWorkBudget,
): Generator<FanoutRoutePlan> {
  const replacementHasSelfIntersection =
    createReplacementSelfIntersectionChecker(plan.segments)
  for (const { segment, index } of plan.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.layer === plan.targetLayer)
    .toSorted(
      (a, b) =>
        distance(b.segment.start, b.segment.end) -
        distance(a.segment.start, a.segment.end),
    )) {
    const length = distance(segment.start, segment.end)
    if (length <= EPSILON) continue
    const dx = Math.abs(segment.end.x - segment.start.x)
    const dy = Math.abs(segment.end.y - segment.start.y)
    if (dx > EPSILON && dy > EPSILON && Math.abs(dx - dy) > EPSILON) continue
    const tangent = {
      x: (segment.end.x - segment.start.x) / length,
      y: (segment.end.y - segment.start.y) / length,
    }
    const pitch = segment.width + clearance
    for (const multiple of [2, 3, 4, 6]) {
      const offset = pitch * multiple
      if (length < 2 * offset + pitch) continue
      for (const sign of [1, -1]) {
        consumeMatchingWork(workBudget)
        const normal = { x: -tangent.y * sign, y: tangent.x * sign }
        const points = [
          segment.start,
          addScaled(addScaled(segment.start, tangent, offset), normal, offset),
          addScaled(addScaled(segment.end, tangent, -offset), normal, offset),
          segment.end,
        ]
        const replacement = points.slice(1).map((end, i) => ({
          ...segment,
          start: points[i]!,
          end,
        }))
        const segments = [
          ...plan.segments.slice(0, index),
          ...replacement,
          ...plan.segments.slice(index + 1),
        ]
        if (replacementHasSelfIntersection(segments, index, replacement.length))
          continue
        if (
          !replacementCopperIsSelfClear({
            plan,
            segments,
            replacementStartIndex: index,
            replacementSegmentCount: replacement.length,
            clearance,
          })
        )
          continue
        const candidate = createPlanWithSegments(plan, segments)
        if (candidate) yield candidate
      }
    }
  }
}

/**
 * Adds straight/45-degree meanders after the dense component escape. Matching
 * is atomic: a constrained bus either satisfies its declared skew with the
 * complete fanout copper still clear, or the complete assignment is rejected.
 */
export interface MatchBusPlanLengthsParams {
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  inputSrj: SimpleRouteJson
  sharedBoundary: Bounds
  clearance: number
  allowBlindAndBuriedVias?: boolean
  allowSameNetMerges?: boolean
  /**
   * Allows tuning on target-layer copper inside the component pad envelope.
   * Intended only for coordinated dense routing whose complete copper is
   * revalidated and whose remaining dogbone capacity is checked atomically.
   */
  allowMatchingInsideDenseBounds?: boolean
  /**
   * Tune existing source-layer copper after the first pad-escape segment and
   * before its fixed first via. Source counts are rebuilt; callers retaining
   * separate source-path maps must rebuild those maps from returned plans.
   * New meanders must also clear the source pad and all retained self copper.
   */
  allowSourcePrefixMatching?: boolean
  /** Tune existing copper on originally permitted internal signal layers. */
  allowTransitLayerMatching?: boolean
  /** Grow existing folds and distribute bounded additions across tuning sites. */
  allowDistributedMatching?: boolean
  /** Add clear through vias to open a tuning window on another permitted signal layer. */
  allowAdditionalMatchingVias?: boolean
  /** Allow a differential pair's longer lane to move aside before tuning its mate. */
  allowPairLaneSpreading?: boolean
  /** Allow one unconstrained boundary lane to move around a tuning meander. */
  allowUnconstrainedLaneRerouting?: boolean
  /**
   * Unfinished direct signal dogbones that may move to clear a tuning window.
   * Complete buses and plane drops are immutable. Callers must rebuild these
   * source reservations from returned plans only after all matching succeeds.
   */
  unroutedSourceBuses?: readonly PreparedBus[]
  /**
   * Rejects a geometrically clear candidate when it would make a caller-owned
   * downstream assignment (such as pending plane dogbones) infeasible.
   */
  candidatePlansAreFeasible?: (plans: readonly FanoutRoutePlan[]) => boolean
  /**
   * Optional deterministic cap shared by the complete matching call and its
   * recursive repairs. Counts attempted meanders (including rejected ones),
   * multi-span states, lane-spreading attempts, and clearance validations.
   * Exhaustion returns the failed bus without committing partial tuning.
   */
  maximumWorkUnits?: number
}

type MatchBusPlanLengthsResult =
  | { plans: FanoutRoutePlan[]; failedBus?: never }
  | { plans: null; failedBus: PreparedBus }

type PlanClearanceValidator = ReturnType<
  typeof createFanoutPlanClearanceValidator
>

export function matchBusPlanLengths(
  params: MatchBusPlanLengthsParams,
): MatchBusPlanLengthsResult {
  if (
    params.maximumWorkUnits !== undefined &&
    (!Number.isSafeInteger(params.maximumWorkUnits) ||
      params.maximumWorkUnits < 0)
  )
    throw new Error("maximumWorkUnits must be a non-negative safe integer")
  const workBudget =
    params.maximumWorkUnits === undefined
      ? undefined
      : ({ remaining: params.maximumWorkUnits } as MatchingWorkBudget)
  const pairs = getDeclaredDifferentialPairs(params.inputSrj)
  const plansByIndex = new Map<number, FanoutRoutePlan[]>()
  for (const plan of params.plans) {
    const matches = plansByIndex.get(plan.connectionIndex) ?? []
    matches.push(plan)
    plansByIndex.set(plan.connectionIndex, matches)
  }
  // Callers may match a completed signal stage before routing unconstrained
  // planes or other buses. An absent bus has no copper to tune yet; once any
  // member is present, its complete original membership is still required.
  params = {
    ...params,
    preparedBuses: params.preparedBuses.filter(
      (bus) =>
        bus.maxLengthSkew !== undefined ||
        bus.connections.some((connection) =>
          plansByIndex.has(connection.connectionIndex),
        ),
    ),
  }
  // Matching subsets below are internal only. Public callers still identify
  // complete original buses and exactly one original plan for each member.
  for (const bus of params.preparedBuses) {
    if (
      bus.connections.some((connection) => {
        const matches = plansByIndex.get(connection.connectionIndex)
        return (
          matches?.length !== 1 ||
          matches[0]!.busId !== bus.busId ||
          matches[0]!.connectionName !== connection.connection.name ||
          params.inputSrj.connections[connection.connectionIndex]?.name !==
            connection.connection.name
        )
      })
    )
      return { plans: null, failedBus: bus }
  }
  // Recursive pair repairs share this call's fixed SRJ and clearance rules.
  // Keep their immutable-plan checks warm without extending the cache beyond
  // the public call or caching work budgets and downstream feasibility checks.
  const validatePlans = createFanoutPlanClearanceValidator({
    srj: params.inputSrj,
    sharedBoundary: params.sharedBoundary,
    clearance: params.clearance,
    allowBlindAndBuriedVias: params.allowBlindAndBuriedVias,
    allowSameNetMerges: params.allowSameNetMerges,
  })
  try {
    const matched = matchBusPlanLengthsWithBudget(
      params,
      validatePlans,
      workBudget,
    )
    return matched.plans
      ? matchDeclaredPairLengths(
          params,
          matched.plans,
          pairs,
          validatePlans,
          workBudget,
        )
      : matched
  } catch (error) {
    if (error instanceof MatchingWorkBudgetExhausted && workBudget?.activeBus)
      return {
        plans: null,
        failedBus:
          params.preparedBuses.find(
            (bus) => bus.busId === workBudget.activeBus!.busId,
          ) ?? workBudget.activeBus,
      }
    throw error
  }
}

/** Pair tuning is private to the complete original bus and the caller's scope. */
function matchDeclaredPairLengths(
  params: MatchBusPlanLengthsParams,
  originalPlans: FanoutRoutePlan[],
  pairs: readonly DeclaredDifferentialPair[],
  validatePlans: PlanClearanceValidator,
  workBudget?: MatchingWorkBudget,
): MatchBusPlanLengthsResult {
  const byIndex = new Map(
    params.preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const activePairs = pairs.filter((pair) =>
    pair.connectionIndices.some((index) => byIndex.has(index)),
  )
  if (!activePairs.length) return { plans: originalPlans }
  const scopedBuses = params.preparedBuses.map((bus) => ({
    bus,
    indices: new Set(
      bus.connections.map((connection) => connection.connectionIndex),
    ),
  }))
  let plans = originalPlans
  const pairPlans = (
    candidate: readonly FanoutRoutePlan[],
    pair: DeclaredDifferentialPair,
  ) =>
    pair.connectionIndices.map((index, i) => {
      const matches = candidate.filter((plan) => plan.connectionIndex === index)
      const plan = matches[0]
      if (
        matches.length !== 1 ||
        plan?.connectionName !== pair.connectionNames[i] ||
        !Number.isFinite(plan.length)
      )
        throw new Error(
          `Differential-pair matching cannot resolve exactly one original plan for ${pair.connectionNames[i]}`,
        )
      const measured = [
        ...plan.segments,
        ...(plan.planeEndpointSegments ?? []),
      ].reduce((sum, segment) => sum + distance(segment.start, segment.end), 0)
      if (
        !Number.isFinite(measured) ||
        Math.abs(measured - plan.length) > EPSILON
      )
        throw new Error(
          `Differential-pair matching found inconsistent copper length for ${plan.connectionName}`,
        )
      return plan
    })
  const originalBusLimitsHold = (candidate: readonly FanoutRoutePlan[]) =>
    scopedBuses.every(({ bus, indices }) => {
      if (bus.maxLengthSkew === undefined) return true
      const own = getPlansForIndices(candidate, indices)
      return (
        own.length === bus.connections.length &&
        getBusSkew(own) <= bus.maxLengthSkew + EPSILON
      )
    })
  // Overlapping pairs may require propagating a new minimum through their
  // connected members. Lengthening is bounded by the existing pair maximum,
  // and every pass shares the original deterministic matching work budget.
  for (let pass = 0; pass <= activePairs.length; pass++) {
    for (const pair of activePairs) {
      const own = pairPlans(plans, pair)
      if (getBusSkew(own) <= pair.lengthTolerance + EPSILON) continue
      const entries = pair.connectionIndices.map((index) => byIndex.get(index))
      const owner = entries.find((entry) => entry)!.bus
      // A single-bus repair must never tune a mate outside its explicit scope.
      if (entries.some((entry) => !entry))
        return { plans: null, failedBus: owner }
      const shortest = own[0]!.length <= own[1]!.length ? 0 : 1
      const laneBus = entries[shortest]!.bus
      const constraintBus: PreparedBus = {
        ...laneBus,
        connections: entries.map((entry) => entry!.connection),
        maxLengthSkew: pair.lengthTolerance,
      }
      const maximum = Math.max(...own.map((plan) => plan.length))
      const result = matchBusPlanLengthsWithBudget(
        {
          ...params,
          plans,
          preparedBuses: [constraintBus],
          // A synthetic matching subset never changes route bus IDs or gives
          // permission to move a different bus's source reservations.
          unroutedSourceBuses: undefined,
          allowUnconstrainedLaneRerouting: false,
          allowPairLaneSpreading:
            entries[0]!.bus === entries[1]!.bus &&
            params.allowPairLaneSpreading,
          candidatePlansAreFeasible: (candidate) =>
            originalBusLimitsHold(candidate) &&
            pairPlans(candidate, pair).every(
              (plan) => plan.length <= maximum + EPSILON,
            ) &&
            (!params.candidatePlansAreFeasible ||
              params.candidatePlansAreFeasible(candidate)),
        },
        validatePlans,
        workBudget,
      )
      if (!result.plans) return { plans: null, failedBus: laneBus }
      plans = result.plans
    }
    if (
      activePairs.every(
        (pair) =>
          getBusSkew(pairPlans(plans, pair)) <= pair.lengthTolerance + EPSILON,
      )
    ) {
      if (!originalBusLimitsHold(plans))
        return {
          plans: null,
          failedBus: scopedBuses.find(
            ({ bus, indices }) =>
              bus.maxLengthSkew !== undefined &&
              getBusSkew(getPlansForIndices(plans, indices)) >
                bus.maxLengthSkew + EPSILON,
          )!.bus,
        }
      return { plans }
    }
  }
  const failed = activePairs.find(
    (pair) =>
      getBusSkew(pairPlans(plans, pair)) > pair.lengthTolerance + EPSILON,
  )!
  return {
    plans: null,
    failedBus: failed.connectionIndices
      .map((index) => byIndex.get(index)?.bus)
      .find((bus) => bus)!,
  }
}

function matchBusPlanLengthsWithBudget(
  params: MatchBusPlanLengthsParams,
  validatePlans: PlanClearanceValidator,
  workBudget?: MatchingWorkBudget,
): MatchBusPlanLengthsResult {
  const {
    preparedBuses,
    inputSrj,
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias = true,
    allowSameNetMerges = false,
    allowMatchingInsideDenseBounds = false,
    candidatePlansAreFeasible,
  } = params
  const plansAreClear = (plans: readonly FanoutRoutePlan[]): boolean => {
    consumeMatchingWork(workBudget)
    return validatePlans(plans)
  }
  let matchedPlans = [...params.plans]
  let sourceRematchAttempts = 0
  const unroutedSourceIndices = new Set(
    params.unroutedSourceBuses?.flatMap((bus) =>
      bus.connections.map((connection) => connection.connectionIndex),
    ),
  )
  const constrainedBuses = preparedBuses.filter(
    (bus) => bus.maxLengthSkew !== undefined && bus.connections.length > 1,
  )
  if (constrainedBuses.length === 0) return { plans: matchedPlans }

  for (const bus of constrainedBuses) {
    const busIndices = new Set(
      bus.connections.map((connection) => connection.connectionIndex),
    )
    if (workBudget) workBudget.activeBus = bus
    if (bus.termination.type !== "boundary") {
      return { plans: null, failedBus: bus }
    }
    const maximumIterations =
      bus.connections.length * (params.allowDistributedMatching ? 24 : 2)
    const deferredLanes = new Set<number>()
    for (let iteration = 0; iteration < maximumIterations; iteration++) {
      const busPlans = getPlansForIndices(matchedPlans, busIndices)
      if (busPlans.length !== bus.connections.length) {
        return { plans: null, failedBus: bus }
      }
      const maxLengthSkew = bus.maxLengthSkew!
      const skew = getBusSkew(busPlans)
      if (skew <= maxLengthSkew + EPSILON) break
      const shortest = busPlans
        .filter((plan) => !deferredLanes.has(plan.connectionIndex))
        .toSorted(
          (first, second) =>
            first.length - second.length ||
            first.connectionName.localeCompare(second.connectionName),
        )[0]!
      const longestLength = Math.max(...busPlans.map((plan) => plan.length))
      if (
        !shortest ||
        longestLength - shortest.length <= maxLengthSkew + EPSILON
      )
        return { plans: null, failedBus: bus }
      const deficit = longestLength - shortest.length
      const minimumRequiredAddition = Math.max(
        EPSILON,
        deficit - maxLengthSkew + EPSILON,
      )
      const targetAddedLengths = [
        minimumRequiredAddition,
        minimumRequiredAddition + maxLengthSkew * 0.1,
        deficit - maxLengthSkew * 0.5,
        deficit - maxLengthSkew * 0.75,
        deficit,
        deficit + maxLengthSkew,
      ]
        .filter(
          (value, index, values) =>
            value > EPSILON &&
            values.findIndex(
              (candidate) => Math.abs(candidate - value) < EPSILON,
            ) === index,
        )
        .toSorted((first, second) => first - second)
      let acceptedPlans: FanoutRoutePlan[] | null = null
      const acceptCandidate = (
        candidate: FanoutRoutePlan,
      ): FanoutRoutePlan[] | null => {
        const nextPlans = matchedPlans.map((plan) =>
          plan === shortest ? candidate : plan,
        )
        const nextBusPlans = getPlansForIndices(nextPlans, busIndices)
        if (getBusSkew(nextBusPlans) > skew + EPSILON) return null
        if (!plansAreClear(nextPlans)) {
          return null
        }
        if (
          candidatePlansAreFeasible &&
          !candidatePlansAreFeasible(nextPlans)
        ) {
          return null
        }
        return nextPlans
      }
      const findMultiSpanCandidate = (
        targetAddedLength: number,
      ): FanoutRoutePlan[] | null => {
        const maximumSearchStates = 320
        const maximumCandidatesPerState = 48
        let searchedStateCount = 0
        const sampleCandidates = (
          candidates: readonly FanoutRoutePlan[],
        ): FanoutRoutePlan[] => {
          if (candidates.length <= maximumCandidatesPerState) {
            return [...candidates]
          }
          return Array.from(
            { length: maximumCandidatesPerState },
            (_, sampleIndex) =>
              candidates[
                Math.floor(
                  (sampleIndex * candidates.length) / maximumCandidatesPerState,
                )
              ]!,
          )
        }
        const search = (
          currentPlan: FanoutRoutePlan,
          stagesRemaining: number,
        ): FanoutRoutePlan[] | null => {
          consumeMatchingWork(workBudget)
          const addedLength = currentPlan.length - shortest.length
          const remainingAddition = targetAddedLength - addedLength
          if (remainingAddition <= EPSILON) {
            return acceptCandidate(currentPlan)
          }
          if (stagesRemaining <= 0) return null
          const stageAddedLength = remainingAddition / stagesRemaining
          const candidates = sampleCandidates([
            ...createTunedPlanCandidates({
              plan: currentPlan,
              bus,
              targetAddedLength: stageAddedLength,
              clearance,
              sharedBoundary: bus.sharedBoundary,
              allowInsideDenseBounds: allowMatchingInsideDenseBounds,
              allowSourcePrefixMatching: params.allowSourcePrefixMatching,
              allowTransitLayerMatching: params.allowTransitLayerMatching,
              workBudget,
            }),
          ])
          for (const candidate of candidates) {
            searchedStateCount++
            if (searchedStateCount > maximumSearchStates) return null
            if (!acceptCandidate(candidate)) continue
            const result = search(candidate, stagesRemaining - 1)
            if (result) return result
          }
          return null
        }
        for (let stageCount = 2; stageCount <= 8; stageCount++) {
          const result = search(shortest, stageCount)
          if (result) return result
          if (searchedStateCount > maximumSearchStates) break
        }
        return null
      }
      for (const targetAddedLength of targetAddedLengths) {
        if (params.allowDistributedMatching) {
          for (const candidate of createExtendedFoldCandidates({
            plan: shortest,
            bus,
            targetAddedLength,
            clearance,
            allowInsideDenseBounds: allowMatchingInsideDenseBounds,
            allowSourcePrefixMatching: params.allowSourcePrefixMatching,
            allowTransitLayerMatching: params.allowTransitLayerMatching,
            workBudget,
          })) {
            acceptedPlans = acceptCandidate(candidate)
            if (acceptedPlans) break
          }
          if (acceptedPlans) break
        }
        const candidates = createTunedPlanCandidates({
          plan: shortest,
          bus,
          targetAddedLength,
          clearance,
          sharedBoundary: bus.sharedBoundary,
          allowInsideDenseBounds: allowMatchingInsideDenseBounds,
          allowSourcePrefixMatching: params.allowSourcePrefixMatching,
          allowTransitLayerMatching: params.allowTransitLayerMatching,
          workBudget,
        })
        for (const candidate of candidates) {
          acceptedPlans = acceptCandidate(candidate)
          if (!acceptedPlans) continue
          break
        }
        if (
          !acceptedPlans &&
          Math.abs(targetAddedLength - minimumRequiredAddition) <= EPSILON
        ) {
          if (params.allowDistributedMatching) {
            for (const addition of [
              targetAddedLength / 2,
              targetAddedLength / 4,
              Math.min(targetAddedLength, 1),
              Math.min(targetAddedLength, 0.5),
              Math.min(targetAddedLength, 0.25),
              Math.min(targetAddedLength, 0.1),
            ]) {
              if (addition <= EPSILON) continue
              const options = {
                plan: shortest,
                bus,
                targetAddedLength: addition,
                clearance,
                sharedBoundary: bus.sharedBoundary,
                allowInsideDenseBounds: allowMatchingInsideDenseBounds,
                allowSourcePrefixMatching: params.allowSourcePrefixMatching,
                allowTransitLayerMatching: params.allowTransitLayerMatching,
                workBudget,
              }
              for (const candidates of [
                createExtendedFoldCandidates(options),
                createTunedPlanCandidates(options),
              ]) {
                for (const candidate of candidates) {
                  acceptedPlans = acceptCandidate(candidate)
                  if (acceptedPlans) break
                }
                if (acceptedPlans) break
              }
              if (acceptedPlans) break
            }
          }
          if (!acceptedPlans)
            acceptedPlans = findMultiSpanCandidate(targetAddedLength)
        }
        if (acceptedPlans) break
      }
      if (!acceptedPlans && params.allowAdditionalMatchingVias) {
        for (const base of createTransitTuningBases({
          plan: shortest,
          bus,
          layerNames: getCopperLayerNames(inputSrj.layerCount),
          clearance,
          workBudget,
        })) {
          if (
            !plansAreClear(
              matchedPlans.map((plan) =>
                plan === shortest ? base.plan : plan,
              ),
            )
          )
            continue
          const options = {
            plan: { ...base.plan, targetLayer: base.tuningLayer },
            bus,
            targetAddedLength: minimumRequiredAddition,
            clearance,
            sharedBoundary: bus.sharedBoundary,
            allowInsideDenseBounds: allowMatchingInsideDenseBounds,
            workBudget,
          }
          for (const candidates of [
            createExtendedFoldCandidates(options),
            createTunedPlanCandidates(options),
          ]) {
            for (const tuned of candidates) {
              if (
                !addedTuningViasAreSelfClear(tuned, base.addedVias, clearance)
              )
                continue
              acceptedPlans = acceptCandidate({
                ...tuned,
                targetLayer: shortest.targetLayer,
              })
              if (acceptedPlans) break
            }
            if (acceptedPlans) break
          }
          if (acceptedPlans) break
        }
      }
      if (
        !acceptedPlans &&
        params.allowPairLaneSpreading &&
        bus.connections.length === 2
      ) {
        // A tightly packed pair may leave no space to lengthen the inner lane.
        // Move the outer lane, then retune the complete pair atomically. Only
        // four geometrically clear placements may start another matching pass.
        const longer = busPlans.find((plan) => plan !== shortest)!
        let attempts = 0
        for (const candidate of createSpreadLaneCandidates(
          longer,
          clearance,
          workBudget,
        )) {
          const nextPlans = matchedPlans.map((plan) =>
            plan === longer ? candidate : plan,
          )
          if (!plansAreClear(nextPlans)) continue
          if (
            candidatePlansAreFeasible &&
            !candidatePlansAreFeasible(nextPlans)
          )
            continue
          const result = matchBusPlanLengthsWithBudget(
            {
              ...params,
              plans: nextPlans,
              preparedBuses: [bus],
              allowPairLaneSpreading: false,
            },
            validatePlans,
            workBudget,
          )
          if (result.plans) {
            acceptedPlans = result.plans
            break
          }
          if (++attempts >= 4) break
        }
      }
      if (!acceptedPlans && params.allowUnconstrainedLaneRerouting) {
        // A neighboring singleton may occupy the only tuning window. Keep its
        // source dogbone, via and boundary endpoint fixed, and reroute only its
        // target-layer copper around a complete meander. Constrained buses and
        // plane routes are never displaced by this bounded repair.
        let rerouteAttempts = 0
        candidateSearch: for (const targetAddedLength of targetAddedLengths) {
          const candidates = createTunedPlanCandidates({
            plan: shortest,
            bus,
            targetAddedLength,
            clearance,
            sharedBoundary: bus.sharedBoundary,
            allowInsideDenseBounds: allowMatchingInsideDenseBounds,
            allowSourcePrefixMatching: params.allowSourcePrefixMatching,
            allowTransitLayerMatching: params.allowTransitLayerMatching,
            workBudget,
          })
          for (const candidate of candidates) {
            if (!plansAreClear([candidate])) continue
            const blockers = matchedPlans.filter(
              (plan) =>
                plan !== shortest &&
                !fanoutPlansAreMutuallyClear({
                  plans: [candidate, plan],
                  srj: inputSrj,
                  clearance,
                  allowSameNetMerges,
                }),
            )
            if (blockers.length !== 1) continue
            const blocker = blockers[0]!
            const blockerBus = preparedBuses.find(
              (prepared) => prepared.busId === blocker.busId,
            )
            if (
              !blockerBus ||
              blockerBus.termination.type !== "boundary" ||
              blockerBus.maxLengthSkew !== undefined ||
              blockerBus.connections.length !== 1 ||
              !blocker.via ||
              blocker.additionalVias?.length ||
              blocker.planeEndpointVia ||
              blocker.segments.filter(
                (segment) => segment.layer === blocker.sourceLayer,
              ).length !== 1
            )
              continue
            const nextPlans = matchedPlans.map((plan) =>
              plan === shortest ? candidate : plan,
            )
            for (const alignGridToPads of [true, false]) {
              if (rerouteAttempts++ >= 4) break candidateSearch
              const rerouted = routeViaMinimalWinding({
                srj: inputSrj,
                bus: blockerBus,
                terminals: [
                  {
                    connection: blockerBus.connections[0]!,
                    viaPoint: blocker.via.center,
                    exitPoint: blocker.exitPoint,
                  },
                ],
                targetLayer: blocker.targetLayer,
                acceptedPlans: nextPlans.filter((plan) => plan !== blocker),
                layerNames: getCopperLayerNames(inputSrj.layerCount),
                traceWidth: blocker.segments[0]!.width,
                viaDiameter: blocker.via.diameter,
                viaHoleDiameter: blocker.via.holeDiameter,
                clearance,
                allowBlindAndBuriedVias,
                allowSameNetMerges,
                gridStepDivisor: 2,
                alignGridToPads,
                maximumRouteOrderAttempts: 1,
                preferTargetDirectedLaneBias: true,
              })?.[0]
              if (!rerouted) continue
              // Rebuild from the original plan to preserve its route identity,
              // endpoint metadata and physical via span exactly.
              const repaired = createPlanWithSegments(blocker, [
                blocker.segments[0]!,
                ...rerouted.segments.slice(1),
              ])
              if (!repaired) continue
              const repairedPlans = nextPlans.map((plan) =>
                plan === blocker ? repaired : plan,
              )
              if (
                getBusSkew(getPlansForIndices(repairedPlans, busIndices)) >
                  maxLengthSkew + EPSILON ||
                !plansAreClear(repairedPlans) ||
                (candidatePlansAreFeasible &&
                  !candidatePlansAreFeasible(repairedPlans))
              )
                continue
              acceptedPlans = repairedPlans
              break candidateSearch
            }
          }
        }
      }
      if (!acceptedPlans && params.unroutedSourceBuses?.length) {
        // A future via barrel can occupy every otherwise clear tuning window.
        // Rematch only unfinished sources, keeping this proposed meander and
        // all completed copper hard. No source change escapes a failed match.
        sourceSearch: for (const targetAddedLength of targetAddedLengths) {
          for (const candidate of createTunedPlanCandidates({
            plan: shortest,
            bus,
            targetAddedLength,
            clearance,
            sharedBoundary: bus.sharedBoundary,
            allowInsideDenseBounds: allowMatchingInsideDenseBounds,
            allowSourcePrefixMatching: params.allowSourcePrefixMatching,
            allowTransitLayerMatching: params.allowTransitLayerMatching,
            workBudget,
          })) {
            if (sourceRematchAttempts >= 4) break sourceSearch
            if (!plansAreClear([candidate])) continue
            const blockers = matchedPlans.filter(
              (plan) =>
                plan !== shortest &&
                !fanoutPlansAreMutuallyClear({
                  plans: [candidate, plan],
                  srj: inputSrj,
                  clearance,
                  allowSameNetMerges,
                }),
            )
            if (
              blockers.length !== 1 ||
              !unroutedSourceIndices.has(blockers[0]!.connectionIndex)
            )
              continue
            sourceRematchAttempts++
            const repaired = rematchUnroutedSourceDogbones({
              inputSrj,
              plans: matchedPlans.map((plan) =>
                plan === shortest ? candidate : plan,
              ),
              unroutedSourceBuses: params.unroutedSourceBuses,
              clearance,
            })
            if (
              !repaired ||
              getBusSkew(getPlansForIndices(repaired, busIndices)) >
                skew + EPSILON ||
              !plansAreClear(repaired) ||
              (candidatePlansAreFeasible &&
                !candidatePlansAreFeasible(repaired))
            )
              continue
            acceptedPlans = repaired
            break sourceSearch
          }
        }
      }
      if (!acceptedPlans) {
        if (params.allowDistributedMatching) {
          // Finish the other lanes in this private candidate before reporting
          // the blocked bus. No partly matched bus escapes the final check.
          deferredLanes.add(shortest.connectionIndex)
          continue
        }
        return { plans: null, failedBus: bus }
      }
      matchedPlans = acceptedPlans
    }
    const matchedBusPlans = getPlansForIndices(matchedPlans, busIndices)
    if (getBusSkew(matchedBusPlans) > bus.maxLengthSkew! + EPSILON) {
      return { plans: null, failedBus: bus }
    }
  }
  return { plans: matchedPlans }
}
