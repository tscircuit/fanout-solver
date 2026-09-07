import { distance, distanceSegmentToSegment } from "./geometry"
import {
  matchSourceViaSites,
  type SourceViaSiteFailure,
} from "./match-source-via-sites"
import { fanoutPlansAreClear, type RouteBusParams } from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import {
  buildViaMinimalWindingPlan,
  type RouteViaMinimalWindingProgress,
  routeViaMinimalWindingAlternativesSteps,
} from "./route-via-minimal-winding"
import type {
  Bounds,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
} from "./types"

interface CandidateParams {
  bus: PreparedBus
  connection: PreparedConnection
  sourceBoundary: Bounds
  viaDiameter: number
  clearance: number
}

/** Provisional first-via sites; none is accepted without full source checks. */
export function getBottomSourceLayerViaCandidates(
  params: CandidateParams,
): Point2D[] {
  const { bus, connection, sourceBoundary, viaDiameter, clearance } = params
  if (bus.exitEdge !== "bottom") return []
  if (!bus.connections.includes(connection))
    throw Error("Source connection is not in its prepared bus")
  const pitch = viaDiameter + clearance + 1e-5
  const x = (connection.exitTargetPoint ?? connection.targetPoint).x
  const bounds = bus.sharedBoundary
  const radius = viaDiameter / 2
  const candidates: Point2D[] = []
  for (let row = 1; row <= 8; row++) {
    for (const shift of [0, -pitch, pitch]) {
      const point = { x: x + shift, y: sourceBoundary.minY - row * pitch }
      if (
        point.x < bounds.minX + radius ||
        point.x > bounds.maxX - radius ||
        point.y < bounds.minY + radius ||
        point.y > bounds.maxY - radius
      )
        continue
      candidates.push(point)
    }
  }
  return candidates
}

export interface BottomSourceLayerRecoveryParams
  extends Pick<
    RouteBusParams,
    | "srj"
    | "layerNames"
    | "traceWidth"
    | "clearance"
    | "viaDiameter"
    | "viaHoleDiameter"
    | "allowBlindAndBuriedVias"
    | "allowSameNetMerges"
  > {
  preparedBuses: readonly PreparedBus[]
  sourceEscapes: readonly PeripheralSourceEscape[]
  /** Every original connection must have its current route or source reservation. */
  plans: readonly FanoutRoutePlan[]
  connection: PreparedConnection
  sourceBoundary: Bounds
  maximumCandidates?: number
  maximumPlaneSearchStates?: number
  maximumPlaneProtectionRounds?: number
}

export interface BottomSourceLayerRecoveryResult {
  sourceEscapes: PeripheralSourceEscape[]
  plans: FanoutRoutePlan[]
  sourcePlans: FanoutRoutePlan[]
  viaPointsByConnectionIndex: Map<number, Point2D>
  changedConnectionIndices: number[]
  candidateCount: number
}

export interface BottomSourceLayerRecoveryProgress {
  phase: "source-layer-winding" | "source-plane-rematch"
  connectionIndex: number
  candidateIndex: number
  winding?: RouteViaMinimalWindingProgress
  planeFailure?: SourceViaSiteFailure
}

function isSourceReservation(
  plan: FanoutRoutePlan,
  sourceEscape: PeripheralSourceEscape,
): boolean {
  return (
    Boolean(plan.via) &&
    distance(plan.via!.center, sourceEscape.via.center) < 1e-8 &&
    plan.via!.diameter === sourceEscape.via.diameter &&
    plan.via!.holeDiameter === sourceEscape.via.holeDiameter &&
    plan.via!.fromLayer === sourceEscape.via.fromLayer &&
    plan.via!.toLayer === sourceEscape.via.toLayer &&
    JSON.stringify(plan.via!.spanLayers) ===
      JSON.stringify(sourceEscape.via.spanLayers) &&
    !plan.additionalVias?.length &&
    !plan.planeEndpointSegments?.length &&
    !plan.planeEndpointVia &&
    plan.segments.length === sourceEscape.segments.length &&
    distance(plan.exitPoint, sourceEscape.via.center) < 1e-8 &&
    plan.segments.every((segment, index) => {
      const expected = sourceEscape.segments[index]!
      return (
        segment.layer === expected.layer &&
        segment.width === expected.width &&
        distance(segment.start, expected.start) < 1e-8 &&
        distance(segment.end, expected.end) < 1e-8
      )
    })
  )
}

function sourcePathHasValidShape(plan: FanoutRoutePlan): boolean {
  for (const [index, segment] of plan.segments.entries()) {
    const dx = segment.end.x - segment.start.x
    const dy = segment.end.y - segment.start.y
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
    const previous = plan.segments[index - 1]
    if (previous) {
      const px = previous.end.x - previous.start.x
      const py = previous.end.y - previous.start.y
      if (
        distance(previous.end, segment.start) > 1e-7 ||
        (px * dx + py * dy) / length / Math.hypot(px, py) < Math.SQRT1_2 - 1e-7
      )
        return false
    }
    for (let otherIndex = 0; otherIndex < index - 1; otherIndex++) {
      const other = plan.segments[otherIndex]!
      if (
        distanceSegmentToSegment(
          segment.start,
          segment.end,
          other.start,
          other.end,
        ) < 1e-8
      )
        return false
    }
  }
  return true
}

/** Relocate one unfinished signal before its first via, rematching eligible
 * source-only planes exactly. Completed routes and other signals remain fixed. */
function* routeBottomSourceLayerRecoveryAttemptSteps(
  params: BottomSourceLayerRecoveryParams & {
    protectedPlaneConnectionIndices: ReadonlySet<number>
  },
): Generator<
  BottomSourceLayerRecoveryProgress,
  BottomSourceLayerRecoveryResult | null,
  void
> {
  const maximumCandidates = params.maximumCandidates ?? 24
  const maximumPlaneSearchStates = params.maximumPlaneSearchStates ?? 300_000
  if (
    !Number.isSafeInteger(maximumCandidates) ||
    maximumCandidates < 0 ||
    maximumCandidates > 24 ||
    !Number.isSafeInteger(maximumPlaneSearchStates) ||
    maximumPlaneSearchStates < 1 ||
    maximumPlaneSearchStates > 300_000
  )
    throw Error(
      "Source recovery requires bounded candidate and plane-search budgets",
    )
  const holders = new Map(
    params.preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const escapes = new Map(
    params.sourceEscapes.map((sourceEscape) => [
      sourceEscape.connectionIndex,
      sourceEscape,
    ]),
  )
  const current = new Map(
    params.plans.map((plan) => [plan.connectionIndex, plan]),
  )
  if (
    holders.size !== escapes.size ||
    holders.size !== current.size ||
    escapes.size !== params.sourceEscapes.length ||
    current.size !== params.plans.length ||
    [...holders.keys()].some((id) => !escapes.has(id) || !current.has(id))
  )
    throw Error(
      "Source recovery requires exactly one source and plan per original connection",
    )
  const id = params.connection.connectionIndex
  const holder = holders.get(id)
  if (!holder || holder.connection !== params.connection)
    throw Error("Requested source is not the original prepared connection")
  const { bus, connection } = holder
  const old = escapes.get(id)!
  if (
    bus.termination.type !== "boundary" ||
    bus.exitEdge !== "bottom" ||
    !isSourceReservation(current.get(id)!, old) ||
    !maximumCandidates
  )
    return null
  const plans = params.plans.map((plan) => {
    const sourceObstacle = holders.get(plan.connectionIndex)!.connection
      .sourceObstacle
    return plan.sourceObstacle === sourceObstacle
      ? plan
      : { ...plan, sourceObstacle }
  })
  const bounds = bus.sharedBoundary
  if (!fanoutPlansAreClear({ ...params, plans, sharedBoundary: bounds }))
    throw Error("Source recovery starts from invalid copper")
  const planeBuses = params.preparedBuses
    .filter((candidate) => candidate.termination.type === "plane")
    .map((candidate) => ({
      ...candidate,
      connections: candidate.connections.filter(
        (c) =>
          !params.protectedPlaneConnectionIndices.has(c.connectionIndex) &&
          isSourceReservation(
            current.get(c.connectionIndex)!,
            escapes.get(c.connectionIndex)!,
          ),
      ),
    }))
    .filter((candidate) => candidate.connections.length)
  const planeIds = new Set(
    planeBuses.flatMap((candidate) =>
      candidate.connections.map((c) => c.connectionIndex),
    ),
  )
  const fixed = plans.filter(
    (plan) =>
      plan.connectionIndex !== id && !planeIds.has(plan.connectionIndex),
  )
  const softReservedVias = params.sourceEscapes
    .filter((sourceEscape) => planeIds.has(sourceEscape.connectionIndex))
    .map((sourceEscape) => ({
      connectionName: sourceEscape.connectionName,
      via: sourceEscape.via,
    }))
  const sourcePlan = (
    sourceEscape: PeripheralSourceEscape,
  ): FanoutRoutePlan => {
    const h = holders.get(sourceEscape.connectionIndex)!
    const plan = buildViaMinimalWindingPlan({
      ...params,
      bus: h.bus,
      targetLayer: sourceEscape.via.toLayer,
      allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
      terminal: {
        connection: h.connection,
        viaPoint: sourceEscape.via.center,
        exitPoint: sourceEscape.via.center,
      },
      sourceEscapePoints: [
        sourceEscape.segments[0]!.start,
        ...sourceEscape.segments.map((segment) => segment.end),
      ],
      targetLayerPoints: [sourceEscape.via.center, sourceEscape.via.center],
    })
    return {
      ...plan,
      via: sourceEscape.via,
      termination: { type: "plane", layer: sourceEscape.via.toLayer },
      sourceEscapeSegmentCount: sourceEscape.segments.length,
    }
  }
  const points = getBottomSourceLayerViaCandidates({ ...params, bus }).slice(
    0,
    maximumCandidates,
  )
  for (const [candidateIndex, point] of points.entries()) {
    const steps = routeViaMinimalWindingAlternativesSteps(
      {
        ...params,
        srj: {
          ...params.srj,
          obstacles: params.srj.obstacles.filter(
            (obstacle) => obstacle !== connection.sourceObstacle,
          ),
        },
        bus: { ...bus, connections: [connection] },
        targetLayer: connection.sourceLayer,
        terminals: [
          { connection, viaPoint: connection.sourcePoint, exitPoint: point },
        ],
        acceptedPlans: fixed,
        softReservedVias,
        sourceEscapePaths: new Map([
          [id, [connection.sourcePoint, connection.sourcePoint]],
        ]),
        allowSourceLayerRouting: true,
        viaDiameter: 0,
        viaHoleDiameter: 0,
        maximumRouteOrderAttempts: 1,
        alignGridToPads: true,
        gridStepDivisor: 2,
      },
      1,
      false,
    )
    let step = steps.next()
    while (!step.done) {
      yield {
        phase: "source-layer-winding",
        connectionIndex: id,
        candidateIndex,
        winding: step.value,
      }
      step = steps.next()
    }
    const path = step.value[0]?.[0]
    if (!path || !sourcePathHasValidShape(path)) continue
    const requested: PeripheralSourceEscape = {
      ...old,
      segments: path.segments,
      via: { ...old.via, center: point },
    }
    const requestedPlan = sourcePlan(requested)
    const committed = [...fixed, requestedPlan]
    if (
      !fanoutPlansAreClear({
        ...params,
        plans: committed,
        sharedBoundary: bounds,
      })
    )
      continue
    let planeFailure: SourceViaSiteFailure | undefined
    const matched = matchSourceViaSites(
      planeBuses,
      {
        ...params,
        additionalObstacles: params.srj.obstacles,
        maximumSearchStates: maximumPlaneSearchStates,
        preferredViaPointsByConnectionIndex: new Map(
          params.sourceEscapes.map((sourceEscape) => [
            sourceEscape.connectionIndex,
            sourceEscape.via.center,
          ]),
        ),
        blockingSegments: committed.flatMap((plan) =>
          [...plan.segments, ...(plan.planeEndpointSegments ?? [])].map(
            (segment) => ({ connectionIndex: plan.connectionIndex, segment }),
          ),
        ),
        blockingVias: committed.flatMap((plan) =>
          [plan.via, ...(plan.additionalVias ?? []), plan.planeEndpointVia]
            .filter((via) => via !== undefined)
            .map((via) => ({ connectionIndex: plan.connectionIndex, ...via })),
        ),
      },
      (failure) => {
        planeFailure = failure
      },
    )
    yield {
      phase: "source-plane-rematch",
      connectionIndex: id,
      candidateIndex,
      planeFailure,
    }
    if (!matched) continue
    const updatedEscapes = params.sourceEscapes.map((sourceEscape) => {
      if (sourceEscape.connectionIndex === id) return requested
      const point = matched.get(sourceEscape.connectionIndex)
      if (!point || distance(point, sourceEscape.via.center) < 1e-9)
        return sourceEscape
      const connection = holders.get(sourceEscape.connectionIndex)!.connection
      return {
        ...sourceEscape,
        via: { ...sourceEscape.via, center: point },
        segments: [
          {
            start: connection.sourcePoint,
            end: point,
            width: params.traceWidth,
            layer: connection.sourceLayer,
          },
        ],
      }
    })
    const updatedByIndex = new Map(
      updatedEscapes.map((sourceEscape) => [
        sourceEscape.connectionIndex,
        sourceEscape,
      ]),
    )
    const full = plans.map((plan) =>
      plan.connectionIndex === id || planeIds.has(plan.connectionIndex)
        ? sourcePlan(updatedByIndex.get(plan.connectionIndex)!)
        : plan,
    )
    if (
      !fanoutPlansAreClear({ ...params, plans: full, sharedBoundary: bounds })
    )
      continue
    return {
      sourceEscapes: updatedEscapes,
      plans: full,
      sourcePlans: updatedEscapes.map(sourcePlan),
      viaPointsByConnectionIndex: new Map(
        updatedEscapes.map((sourceEscape) => [
          sourceEscape.connectionIndex,
          sourceEscape.via.center,
        ]),
      ),
      changedConnectionIndices: updatedEscapes
        .filter(
          (sourceEscape) =>
            sourceEscape !== escapes.get(sourceEscape.connectionIndex),
        )
        .map((sourceEscape) => sourceEscape.connectionIndex),
      candidateCount: candidateIndex + 1,
    }
  }
  return null
}

/** Keep exact failed native plane domains reachable on a bounded source retry.
 * Each retry preserves the identified plane's existing source copper; it does
 * not remove a source reservation or change any previously completed route. */
export function* routeBottomSourceLayerRecoverySteps(
  params: BottomSourceLayerRecoveryParams,
): Generator<
  BottomSourceLayerRecoveryProgress,
  BottomSourceLayerRecoveryResult | null,
  void
> {
  const limit = params.maximumPlaneProtectionRounds ?? 4
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4)
    throw Error("Source plane protection requires one to four attempts")
  const protectedPlaneConnectionIndices = new Set<number>()
  let previousCandidateCount = 0
  for (let attempt = 0; attempt < limit; attempt++) {
    const emptyDomains = new Set<number>()
    const steps = routeBottomSourceLayerRecoveryAttemptSteps({
      ...params,
      protectedPlaneConnectionIndices,
    })
    let step = steps.next()
    while (!step.done) {
      if (
        step.value.phase === "source-plane-rematch" &&
        step.value.planeFailure?.kind === "empty-domains"
      )
        for (const id of step.value.planeFailure.connectionIndices)
          emptyDomains.add(id)
      yield step.value
      step = steps.next()
    }
    if (step.value)
      return {
        ...step.value,
        candidateCount: previousCandidateCount + step.value.candidateCount,
      }
    const additions = [...emptyDomains].filter(
      (id) => !protectedPlaneConnectionIndices.has(id),
    )
    if (!additions.length) return null
    for (const id of additions) protectedPlaneConnectionIndices.add(id)
    previousCandidateCount += params.maximumCandidates ?? 24
  }
  return null
}
