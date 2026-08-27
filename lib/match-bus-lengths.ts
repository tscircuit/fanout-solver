import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
  segmentsAreClear,
} from "./geometry"
import { fanoutPlansAreClear } from "./route-bus"
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
): FanoutRoutePlan | null {
  const route = rebuildTraceRoute(plan, segments)
  if (!route) return null
  const length = [...segments, ...(plan.planeEndpointSegments ?? [])].reduce(
    (total, segment) => total + distance(segment.start, segment.end),
    0,
  )
  return {
    ...plan,
    trace: { ...plan.trace, route },
    segments,
    length,
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

function hasNonAdjacentSelfIntersection(
  segments: readonly RoutedSegment[],
): boolean {
  for (let firstIndex = 0; firstIndex < segments.length; firstIndex++) {
    const first = segments[firstIndex]!
    for (
      let secondIndex = firstIndex + 2;
      secondIndex < segments.length;
      secondIndex++
    ) {
      const second = segments[secondIndex]!
      if (first.layer !== second.layer) continue
      if (
        secondIndex === firstIndex + 2 &&
        pointsMatch(first.end, second.start)
      ) {
        continue
      }
      if (
        distanceSegmentToSegment(
          first.start,
          first.end,
          second.start,
          second.end,
        ) <= EPSILON
      ) {
        return true
      }
    }
  }
  return false
}

function replacementCopperIsSelfClear(params: {
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
  const getConnectedPathDistance = (
    firstIndex: number,
    secondIndex: number,
  ): number => {
    if (firstIndex === secondIndex) return 0
    const startIndex = Math.min(firstIndex, secondIndex)
    const endIndex = Math.max(firstIndex, secondIndex)
    const startSegment = segments[startIndex]!
    const endSegment = segments[endIndex]!
    if (startSegment.layer !== endSegment.layer) {
      return Number.POSITIVE_INFINITY
    }
    let currentPoint = startSegment.end
    let pathDistance = 0
    for (let index = startIndex + 1; index < endIndex; index++) {
      const segment = segments[index]!
      if (
        segment.layer !== startSegment.layer ||
        !pointsMatch(currentPoint, segment.start)
      ) {
        return Number.POSITIVE_INFINITY
      }
      pathDistance += distance(segment.start, segment.end)
      currentPoint = segment.end
    }
    return pointsMatch(currentPoint, segments[endIndex]!.start)
      ? pathDistance
      : Number.POSITIVE_INFINITY
  }
  for (
    let replacementIndex = replacementStartIndex;
    replacementIndex <= replacementEndIndex;
    replacementIndex++
  ) {
    const replacement = segments[replacementIndex]!
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
      if (
        distancePointToSegment(via.center, replacement.start, replacement.end) <
        via.diameter / 2 + replacement.width / 2 + clearance - EPSILON
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

function createTunedPlanCandidates(params: {
  plan: FanoutRoutePlan
  bus: PreparedBus
  targetAddedLength: number
  clearance: number
  sharedBoundary: Bounds
  allowInsideDenseBounds?: boolean
  denseBoundarySplitApplied?: boolean
}): FanoutRoutePlan[] {
  const {
    plan,
    bus,
    targetAddedLength,
    clearance,
    sharedBoundary,
    allowInsideDenseBounds = false,
    denseBoundarySplitApplied = false,
  } = params
  const candidates: FanoutRoutePlan[] = []
  const denseCopperBounds = getDenseCopperBounds(bus)
  const denseMargin = plan.segments[0]?.width
    ? plan.segments[0].width / 2 + clearance
    : clearance
  const eligibleSegments = plan.segments
    .map((segment, segmentIndex) => ({ segment, segmentIndex }))
    .filter(({ segment }) => segment.layer === plan.targetLayer)
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
          if (hasNonAdjacentSelfIntersection(segments)) continue
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
          const candidate = createPlanWithSegments(plan, segments)
          if (candidate) candidates.push(candidate)
        }
      }
    }
  }
  if (denseBoundarySplitApplied) return candidates
  const splitSegments = plan.segments.flatMap((segment) =>
    splitSegmentAtDenseBounds({
      segment,
      bounds: denseCopperBounds,
      margin: denseMargin,
    }),
  )
  const splitPlan = createPlanWithSegments(plan, splitSegments)
  if (!splitPlan) return candidates
  const splitCandidates = createTunedPlanCandidates({
    ...params,
    plan: splitPlan,
    denseBoundarySplitApplied: true,
  })
  return [...candidates, ...splitCandidates]
}

function getBusSkew(plans: readonly FanoutRoutePlan[]): number {
  const lengths = plans.map((plan) => plan.length)
  return Math.max(...lengths) - Math.min(...lengths)
}

/**
 * Adds straight/45-degree meanders after the dense component escape. Matching
 * is atomic: a constrained bus either satisfies its declared skew with the
 * complete fanout copper still clear, or the complete assignment is rejected.
 */
export function matchBusPlanLengths(params: {
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
   * Rejects a geometrically clear candidate when it would make a caller-owned
   * downstream assignment (such as pending plane dogbones) infeasible.
   */
  candidatePlansAreFeasible?: (plans: readonly FanoutRoutePlan[]) => boolean
}):
  | { plans: FanoutRoutePlan[]; failedBus?: never }
  | { plans: null; failedBus: PreparedBus } {
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
  let matchedPlans = [...params.plans]
  const constrainedBuses = preparedBuses.filter(
    (bus) => bus.maxLengthSkew !== undefined && bus.connections.length > 1,
  )
  if (constrainedBuses.length === 0) return { plans: matchedPlans }

  for (const bus of constrainedBuses) {
    if (bus.termination.type !== "boundary") {
      return { plans: null, failedBus: bus }
    }
    const maximumIterations = bus.connections.length * 2
    for (let iteration = 0; iteration < maximumIterations; iteration++) {
      const busPlans = matchedPlans.filter((plan) => plan.busId === bus.busId)
      if (busPlans.length !== bus.connections.length) {
        return { plans: null, failedBus: bus }
      }
      const maxLengthSkew = bus.maxLengthSkew!
      const skew = getBusSkew(busPlans)
      if (skew <= maxLengthSkew + EPSILON) break
      const shortest = busPlans.toSorted(
        (first, second) =>
          first.length - second.length ||
          first.connectionName.localeCompare(second.connectionName),
      )[0]!
      const longestLength = Math.max(...busPlans.map((plan) => plan.length))
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
        const nextBusPlans = nextPlans.filter(
          (plan) => plan.busId === bus.busId,
        )
        if (getBusSkew(nextBusPlans) > skew + EPSILON) return null
        if (
          !fanoutPlansAreClear({
            plans: nextPlans,
            srj: inputSrj,
            sharedBoundary,
            clearance,
            allowBlindAndBuriedVias,
            allowSameNetMerges,
          })
        ) {
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
          const addedLength = currentPlan.length - shortest.length
          const remainingAddition = targetAddedLength - addedLength
          if (remainingAddition <= EPSILON) {
            return acceptCandidate(currentPlan)
          }
          if (stagesRemaining <= 0) return null
          const stageAddedLength = remainingAddition / stagesRemaining
          const candidates = sampleCandidates(
            createTunedPlanCandidates({
              plan: currentPlan,
              bus,
              targetAddedLength: stageAddedLength,
              clearance,
              sharedBoundary: bus.sharedBoundary,
              allowInsideDenseBounds: allowMatchingInsideDenseBounds,
            }),
          )
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
        const candidates = createTunedPlanCandidates({
          plan: shortest,
          bus,
          targetAddedLength,
          clearance,
          sharedBoundary: bus.sharedBoundary,
          allowInsideDenseBounds: allowMatchingInsideDenseBounds,
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
          acceptedPlans = findMultiSpanCandidate(targetAddedLength)
        }
        if (acceptedPlans) break
      }
      if (!acceptedPlans) return { plans: null, failedBus: bus }
      matchedPlans = acceptedPlans
    }
    const matchedBusPlans = matchedPlans.filter(
      (plan) => plan.busId === bus.busId,
    )
    if (getBusSkew(matchedBusPlans) > bus.maxLengthSkew! + EPSILON) {
      return { plans: null, failedBus: bus }
    }
  }
  return { plans: matchedPlans }
}
