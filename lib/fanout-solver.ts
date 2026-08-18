import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "./build-output"
import {
  completeOriginalEndpoints,
  type CompleteOriginalEndpointsResult,
} from "./complete-original-endpoints"
import { generateLayerAssignments, getCopperLayerNames } from "./layer-names"
import {
  prepareFanoutBuses,
  resolveAvailableBoundaryRegions,
} from "./prepare-buses"
import {
  routeBus,
  routeBusAlternatives,
  type RouteBusStaticClearanceCache,
} from "./route-bus"
import { routeSingleLayerWithAdaptiveExits } from "./route-single-layer-adaptive-exits"
import { routeSingleLayerWithPushAndShove } from "./route-single-layer-push-shove"
import { validateFanoutSolution } from "./validate-fanout-solution"
import { visualizeSimpleRouteJson } from "./visualize-simple-route-json"
import type {
  AssignmentAttempt,
  Bounds,
  FanoutAttemptSummary,
  FanoutBorderDistribution,
  FanoutRoutePlan,
  FanoutSolverOptions,
  FanoutSolverOutput,
  PreparedBus,
} from "./types"

interface ResolvedFanoutConfig {
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  compactBusTracks: boolean
  allowSameNetMerges: boolean
  singleLayerPushAndShove: boolean
  singleLayerAdaptiveExits: boolean
  borderDistribution: FanoutBorderDistribution
  layerNames: string[]
  escapeLayers: string[]
  maxLayerCombinations: number
  balanceLayerLoadByConnectionCount: boolean
}

interface EvaluatedAssignment extends AssignmentAttempt {
  blockingBusIds: string[]
}

interface GroupedBeamState {
  assignment: Readonly<Record<string, string>>
  plans: FanoutRoutePlan[]
}

type RoutingStrategy = "default" | "group-by-layer" | "deep-first"

function resolvePositiveNumber(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `FanoutSolver: ${label} must be a positive number, received ${value}`,
    )
  }
  return value
}

function resolveConfig(
  srj: SimpleRouteJson,
  options: FanoutSolverOptions,
): ResolvedFanoutConfig {
  const traceWidth = resolvePositiveNumber(
    "traceWidth",
    options.traceWidth ?? srj.nominalTraceWidth ?? srj.minTraceWidth,
  )
  const viaDiameter = resolvePositiveNumber(
    "viaDiameter",
    options.viaDiameter ??
      srj.minViaPadDiameter ??
      srj.min_via_pad_diameter ??
      srj.minViaDiameter ??
      Math.max(traceWidth * 2, 0.3),
  )
  const viaHoleDiameter = resolvePositiveNumber(
    "viaHoleDiameter",
    options.viaHoleDiameter ??
      srj.minViaHoleDiameter ??
      srj.min_via_hole_diameter ??
      viaDiameter * 0.5,
  )
  if (viaHoleDiameter >= viaDiameter) {
    throw new Error(
      `FanoutSolver: viaHoleDiameter ${viaHoleDiameter} must be smaller than viaDiameter ${viaDiameter}`,
    )
  }
  const clearance = resolvePositiveNumber(
    "clearance",
    options.clearance ??
      srj.minViaEdgeToPadEdgeClearance ??
      srj.minTraceToPadEdgeClearance ??
      srj.defaultObstacleMargin ??
      srj.minTraceWidth,
  )
  const layerNames = getCopperLayerNames(srj.layerCount)
  const escapeLayers = options.escapeLayers ?? layerNames
  for (const layer of escapeLayers) {
    if (!layerNames.includes(layer)) {
      throw new Error(
        `FanoutSolver: escape layer "${layer}" is not available in a ${srj.layerCount}-layer SimpleRouteJson`,
      )
    }
  }
  if (new Set(escapeLayers).size !== escapeLayers.length) {
    throw new Error("FanoutSolver: escapeLayers contains duplicates")
  }
  const borderDistribution = options.borderDistribution ?? "preserve"
  if (borderDistribution !== "preserve" && borderDistribution !== "even") {
    throw new Error(
      `FanoutSolver: borderDistribution must be "preserve" or "even", received "${borderDistribution}"`,
    )
  }

  return {
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    compactBusTracks: options.compactBusTracks ?? false,
    allowSameNetMerges: options.allowSameNetMerges ?? false,
    singleLayerPushAndShove: options.singleLayerPushAndShove ?? false,
    singleLayerAdaptiveExits: options.singleLayerAdaptiveExits ?? false,
    borderDistribution,
    layerNames,
    escapeLayers,
    maxLayerCombinations:
      options.maxLayerCombinations === undefined
        ? 256
        : resolvePositiveNumber(
            "maxLayerCombinations",
            options.maxLayerCombinations,
          ),
    balanceLayerLoadByConnectionCount:
      options.balanceLayerLoadByConnectionCount ?? false,
  }
}

function assignmentLoadPenalty(
  assignment: Readonly<Record<string, string>>,
  buses: readonly PreparedBus[],
  weightByConnectionCount: boolean,
): number {
  const connectionCountByBusId = new Map(
    buses.map((bus) => [bus.busId, bus.connections.length]),
  )
  const loadByLayer = new Map<string, number>()
  for (const [busId, layer] of Object.entries(assignment)) {
    loadByLayer.set(
      layer,
      (loadByLayer.get(layer) ?? 0) +
        (weightByConnectionCount
          ? (connectionCountByBusId.get(busId) ?? 1)
          : 1),
    )
  }
  return [...loadByLayer.values()].reduce(
    (penalty, load) => penalty + load * load,
    0,
  )
}

function getLayerLoadPenaltyWeight(config: ResolvedFanoutConfig): number {
  return config.balanceLayerLoadByConnectionCount ? 0.25 : 0.01
}

function getPlanViaCount(plans: readonly FanoutRoutePlan[]): number {
  return plans.reduce(
    (count, plan) =>
      count +
      Number(Boolean(plan.via)) +
      Number(Boolean(plan.planeEndpointVia)),
    0,
  )
}

function getBusDistanceToBoundary(bus: PreparedBus): number {
  const averageSource =
    bus.connections.reduce((sum, connection) => {
      const sourceAxis =
        bus.direction === "left" || bus.direction === "right"
          ? connection.sourcePoint.x
          : connection.sourcePoint.y
      return sum + sourceAxis
    }, 0) / bus.connections.length
  switch (bus.direction) {
    case "right":
      return bus.sharedBoundary.maxX - averageSource
    case "left":
      return averageSource - bus.sharedBoundary.minX
    case "up":
      return bus.sharedBoundary.maxY - averageSource
    case "down":
      return averageSource - bus.sharedBoundary.minY
  }
}

function busUsesDestinationGuidedTracks(bus: PreparedBus): boolean {
  const isHorizontal = bus.direction === "left" || bus.direction === "right"
  return bus.connections.some((connection) => {
    const exitTargetPoint = connection.exitTargetPoint ?? connection.targetPoint
    const sourceTrack = isHorizontal
      ? connection.sourcePoint.y
      : connection.sourcePoint.x
    const targetTrack = isHorizontal ? exitTargetPoint.y : exitTargetPoint.x
    return Math.abs(sourceTrack - targetTrack) > 1e-6
  })
}

function busIsOnOutwardComponentEdge(bus: PreparedBus): boolean {
  const isHorizontal = bus.direction === "left" || bus.direction === "right"
  const directionalCoordinates = isHorizontal
    ? bus.xCoordinates
    : bus.yCoordinates
  const averageSource =
    bus.connections.reduce(
      (sum, connection) =>
        sum +
        (isHorizontal ? connection.sourcePoint.x : connection.sourcePoint.y),
      0,
    ) / bus.connections.length
  const outwardCoordinate =
    bus.direction === "right" || bus.direction === "up"
      ? Math.max(...directionalCoordinates)
      : Math.min(...directionalCoordinates)
  return Math.abs(averageSource - outwardCoordinate) < 1e-6
}

function getBusDepthInRows(bus: PreparedBus): number {
  const isHorizontal = bus.direction === "left" || bus.direction === "right"
  const directionalCoordinates = isHorizontal
    ? bus.xCoordinates
    : bus.yCoordinates
  const averageSource =
    bus.connections.reduce(
      (sum, connection) =>
        sum +
        (isHorizontal ? connection.sourcePoint.x : connection.sourcePoint.y),
      0,
    ) / bus.connections.length
  const outwardCoordinate =
    bus.direction === "right" || bus.direction === "up"
      ? Math.max(...directionalCoordinates)
      : Math.min(...directionalCoordinates)
  const directionalPitch = isHorizontal ? bus.pitchX : bus.pitchY

  return Math.round(
    Math.abs(averageSource - outwardCoordinate) / directionalPitch,
  )
}

function createInitialLayerAssignment(params: {
  buses: PreparedBus[]
  escapeLayers: string[]
  escapeLayersByBusId: Readonly<Record<string, readonly string[]>>
}): Readonly<Record<string, string>> {
  const { buses, escapeLayers, escapeLayersByBusId } = params
  const assignment: Record<string, string> = {}
  const directionsByComponent = new Map<string, Set<PreparedBus["direction"]>>()
  let nextViaLayerIndex = 0
  for (const bus of buses) {
    const directions = directionsByComponent.get(bus.componentId) ?? new Set()
    directions.add(bus.direction)
    directionsByComponent.set(bus.componentId, directions)
  }

  for (const bus of buses) {
    const sourceLayer = bus.connections[0]?.sourceLayer
    if (!sourceLayer) {
      throw new Error(`FanoutSolver: bus "${bus.busId}" has no connections`)
    }
    if (bus.termination.type === "plane") {
      assignment[bus.busId] = bus.termination.layer
      continue
    }
    const routableEscapeLayers = escapeLayersByBusId[bus.busId] ?? escapeLayers
    const viaLayers = routableEscapeLayers.filter(
      (layer) => layer !== sourceLayer,
    )
    if (
      routableEscapeLayers.includes(sourceLayer) &&
      (busUsesDestinationGuidedTracks(bus) || busIsOnOutwardComponentEdge(bus))
    ) {
      assignment[bus.busId] = sourceLayer
    } else if (viaLayers.length > 0) {
      const componentDirections = directionsByComponent.get(bus.componentId)!
      const hasOpposingDirection =
        (componentDirections.has("left") && componentDirections.has("right")) ||
        (componentDirections.has("up") && componentDirections.has("down"))
      if (hasOpposingDirection) {
        const depthInRows = getBusDepthInRows(bus)
        assignment[bus.busId] =
          viaLayers[Math.max(depthInRows - 1, 0) % viaLayers.length]!
      } else {
        assignment[bus.busId] = viaLayers[nextViaLayerIndex % viaLayers.length]!
        nextViaLayerIndex++
      }
    } else {
      assignment[bus.busId] = sourceLayer
    }
  }

  return assignment
}

function prioritizeLayerAssignment(params: {
  initialAssignment: Readonly<Record<string, string>>
  generatedAssignments: Array<Readonly<Record<string, string>>>
  maxAssignments: number
}): Array<Readonly<Record<string, string>>> {
  const { initialAssignment, generatedAssignments, maxAssignments } = params
  const initialKey = JSON.stringify(initialAssignment)
  return [
    initialAssignment,
    ...generatedAssignments.filter(
      (assignment) => JSON.stringify(assignment) !== initialKey,
    ),
  ].slice(0, maxAssignments)
}

function getCandidateEscapeLayersForBus(params: {
  bus: PreparedBus
  srj: SimpleRouteJson
  config: ResolvedFanoutConfig
  staticClearanceCache: RouteBusStaticClearanceCache
}): string[] {
  const { bus, srj, config, staticClearanceCache } = params
  const busAllowedLayers = bus.allowedLayers
  const allowedEscapeLayers =
    busAllowedLayers === undefined
      ? config.escapeLayers
      : config.escapeLayers.filter((layer) => busAllowedLayers.includes(layer))
  const individuallyRoutableLayers = allowedEscapeLayers.filter(
    (targetLayer) =>
      routeBus({
        srj,
        bus,
        targetLayer,
        acceptedPlans: [],
        layerNames: config.layerNames,
        traceWidth: config.traceWidth,
        viaDiameter: config.viaDiameter,
        viaHoleDiameter: config.viaHoleDiameter,
        clearance: config.clearance,
        compactBusTracks: config.compactBusTracks,
        allowSameNetMerges: config.allowSameNetMerges,
        staticClearanceCache,
      }) !== null,
  )

  // Existing plans only add clearance constraints, so a layer that cannot
  // route this bus by itself cannot become viable later in an assignment.
  // Preserve the original candidates when none route so impossible problems
  // still produce the usual failed-solver result instead of throwing here.
  const candidateLayers =
    individuallyRoutableLayers.length > 0
      ? individuallyRoutableLayers
      : allowedEscapeLayers
  return candidateLayers
}

export class FanoutSolver extends BaseSolver {
  static solverName = "FanoutSolver"

  readonly preparedBuses: PreparedBus[]
  readonly attempts: FanoutAttemptSummary[] = []
  readonly layerAssignments: Array<Readonly<Record<string, string>>>
  readonly config: ResolvedFanoutConfig
  private readonly escapeLayersByBusId: Readonly<
    Record<string, readonly string[]>
  >
  private readonly evaluatedAssignmentKeys = new Set<string>()
  private readonly queuedAssignmentKeys = new Set<string>()
  private readonly assignmentRepairDepthByKey = new Map<string, number>()
  private readonly pendingRepairAssignments: Array<
    Readonly<Record<string, string>>
  > = []
  private readonly routeStaticClearanceCache: RouteBusStaticClearanceCache =
    new Map()
  private readonly routingPrefixCache = new Map<
    string,
    {
      plans: AssignmentAttempt["plans"]
      failedBusIds: string[]
      blockingBusCounts: Map<string, number>
    }
  >()
  private groupedBeamEvaluated = false
  private nextAssignmentIndex = 0
  private nextGeneratedAssignmentIndex = 0
  private bestAttempt: AssignmentAttempt | null = null
  private endpointCompletion: CompleteOriginalEndpointsResult | null = null

  constructor(
    public readonly inputSrj: SimpleRouteJson,
    public readonly options: FanoutSolverOptions = {},
  ) {
    super()
    this.config = resolveConfig(inputSrj, options)
    this.preparedBuses = prepareFanoutBuses(inputSrj, options)
    for (const bus of this.preparedBuses) {
      for (const allowedLayer of bus.allowedLayers ?? []) {
        if (!this.config.layerNames.includes(allowedLayer)) {
          throw new Error(
            `FanoutSolver: bus "${bus.busId}" allows unavailable layer "${allowedLayer}"`,
          )
        }
      }
      if (
        bus.termination.type === "boundary" &&
        bus.allowedLayers !== undefined &&
        !bus.allowedLayers.some((layer) =>
          this.config.escapeLayers.includes(layer),
        )
      ) {
        throw new Error(
          `FanoutSolver: bus "${bus.busId}" has no allowed layer in escapeLayers`,
        )
      }
      if (bus.termination.type !== "plane") continue
      const planeLayer = bus.termination.layer
      if (!this.config.layerNames.includes(planeLayer)) {
        throw new Error(
          `FanoutSolver: plane-terminated bus "${bus.busId}" targets unavailable layer "${planeLayer}"`,
        )
      }
      if (
        bus.allowedLayers !== undefined &&
        !bus.allowedLayers.includes(planeLayer)
      ) {
        throw new Error(
          `FanoutSolver: plane-terminated bus "${bus.busId}" targets disallowed layer "${planeLayer}"`,
        )
      }
      if (
        bus.connections.some(
          (connection) => connection.sourceLayer === planeLayer,
        )
      ) {
        throw new Error(
          `FanoutSolver: plane-terminated bus "${bus.busId}" must target a layer below its source pad`,
        )
      }
    }
    const boundaryBusIds = this.preparedBuses
      .filter((bus) => bus.termination.type === "boundary")
      .map((bus) => bus.busId)
    const fixedPlaneAssignments = Object.fromEntries(
      this.preparedBuses.flatMap((bus) =>
        bus.termination.type === "plane"
          ? [[bus.busId, bus.termination.layer] as const]
          : [],
      ),
    )
    const escapeLayersByBusId = Object.fromEntries(
      this.preparedBuses.flatMap((bus) => {
        if (bus.termination.type === "plane") return []
        return [
          [
            bus.busId,
            getCandidateEscapeLayersForBus({
              bus,
              srj: inputSrj,
              config: this.config,
              staticClearanceCache: this.routeStaticClearanceCache,
            }),
          ] as const,
        ]
      }),
    )
    this.escapeLayersByBusId = escapeLayersByBusId
    const generatedAssignments = generateLayerAssignments({
      busIds: boundaryBusIds,
      layers: this.config.escapeLayers,
      layersByBusId: escapeLayersByBusId,
      maxAssignments: this.config.maxLayerCombinations,
    }).map((assignment) => ({
      ...assignment,
      ...fixedPlaneAssignments,
    }))
    this.layerAssignments = prioritizeLayerAssignment({
      initialAssignment: createInitialLayerAssignment({
        buses: this.preparedBuses,
        escapeLayers: this.config.escapeLayers,
        escapeLayersByBusId,
      }),
      generatedAssignments,
      maxAssignments: this.config.maxLayerCombinations,
    })
    this.MAX_ITERATIONS = this.config.maxLayerCombinations + 2
  }

  override getSolverName(): string {
    return "FanoutSolver"
  }

  private completeBestAttemptEndpoints(): void {
    if (
      !this.options.completeOriginalEndpoints ||
      this.endpointCompletion ||
      !this.bestAttempt
    ) {
      return
    }
    this.endpointCompletion = completeOriginalEndpoints({
      inputSrj: this.inputSrj,
      fanoutSrj: this.bestAttempt.outputSrj,
      plans: this.bestAttempt.plans,
      traceWidth: this.config.traceWidth,
      viaDiameter: this.config.viaDiameter,
      viaHoleDiameter: this.config.viaHoleDiameter,
      clearance: this.config.clearance,
      effort: this.options.endpointCompletionEffort,
      routeDownstreamConnections: this.options.routeDownstreamConnections,
    })
  }

  private getValidationBoundary(): Bounds {
    if (this.options.sharedBoundary) return this.options.sharedBoundary
    const firstBoundary = this.preparedBuses[0]?.sharedBoundary
    if (!firstBoundary) return this.inputSrj.bounds
    return this.preparedBuses.slice(1).reduce<Bounds>(
      (boundary, bus) => ({
        minX: Math.min(boundary.minX, bus.sharedBoundary.minX),
        maxX: Math.max(boundary.maxX, bus.sharedBoundary.maxX),
        minY: Math.min(boundary.minY, bus.sharedBoundary.minY),
        maxY: Math.max(boundary.maxY, bus.sharedBoundary.maxY),
      }),
      { ...firstBoundary },
    )
  }

  private validateCompletePlans(
    plans: readonly FanoutRoutePlan[],
    outputSrj: SimpleRouteJson,
  ) {
    return validateFanoutSolution({
      inputSrj: this.inputSrj,
      outputSrj,
      plans,
      preparedBuses: this.preparedBuses,
      sharedBoundary: this.getValidationBoundary(),
      clearance: this.config.clearance,
    })
  }

  private evaluateAssignmentWithStrategy(
    assignmentIndex: number,
    busLayerAssignments: Readonly<Record<string, string>>,
    routingStrategy: RoutingStrategy,
  ): EvaluatedAssignment {
    let plans: AssignmentAttempt["plans"] = []
    let failedBusIds: string[] = []
    let blockingBusCounts = new Map<string, number>()
    const isSingleLayerFanout = this.config.escapeLayers.length === 1
    if (isSingleLayerFanout && this.config.singleLayerPushAndShove) {
      const singleLayerParams = {
        srj: this.inputSrj,
        buses: this.preparedBuses,
        traceWidth: this.config.traceWidth,
        clearance: this.config.clearance,
        borderDistribution: this.config.borderDistribution,
      }
      const singleLayerPlans =
        routeSingleLayerWithPushAndShove(singleLayerParams) ??
        (this.config.singleLayerAdaptiveExits
          ? routeSingleLayerWithAdaptiveExits({
              ...singleLayerParams,
              availableBoundaryRegions: resolveAvailableBoundaryRegions(
                this.options.availableCornersAndSides,
              ),
            })
          : null)
      if (singleLayerPlans) {
        plans.push(...singleLayerPlans)
      } else {
        failedBusIds.push(...this.preparedBuses.map((bus) => bus.busId))
      }
    }
    const busesInRoutingOrder = [...this.preparedBuses].sort(
      (a, b) =>
        Number(b.termination.type === "plane") -
          Number(a.termination.type === "plane") ||
        (routingStrategy === "group-by-layer"
          ? (busLayerAssignments[a.busId] ?? "").localeCompare(
              busLayerAssignments[b.busId] ?? "",
            )
          : 0) ||
        b.componentObstacles.length - a.componentObstacles.length ||
        (isSingleLayerFanout
          ? getBusDistanceToBoundary(b) - getBusDistanceToBoundary(a)
          : b.connections.length - a.connections.length ||
            (routingStrategy === "deep-first"
              ? getBusDistanceToBoundary(b) - getBusDistanceToBoundary(a)
              : getBusDistanceToBoundary(a) - getBusDistanceToBoundary(b))),
    )

    let routingPrefixKey = `${routingStrategy}|`
    for (const bus of isSingleLayerFanout && this.config.singleLayerPushAndShove
      ? []
      : busesInRoutingOrder) {
      const targetLayer = busLayerAssignments[bus.busId]
      if (!targetLayer) {
        throw new Error(
          `FanoutSolver: assignment ${assignmentIndex} has no layer for bus "${bus.busId}"`,
        )
      }
      // The routing order can change between assignments (notably for
      // group-by-layer search). A layer-only key can therefore replay a
      // prefix belonging to a different bus and duplicate or drop plans when
      // buses contain multiple connections. Include the bus identity so the
      // cache remains valid for grouped power/signal lanes.
      routingPrefixKey += `${bus.busId.length}:${bus.busId};${targetLayer.length}:${targetLayer};`
      const cachedPrefix = this.routingPrefixCache.get(routingPrefixKey)
      if (cachedPrefix) {
        plans = [...cachedPrefix.plans]
        failedBusIds = [...cachedPrefix.failedBusIds]
        blockingBusCounts = new Map(cachedPrefix.blockingBusCounts)
        continue
      }
      const currentBusBlockingCounts = new Map<string, number>()
      const busPlans = routeBus({
        srj: this.inputSrj,
        bus,
        targetLayer,
        acceptedPlans: plans,
        layerNames: this.config.layerNames,
        traceWidth: this.config.traceWidth,
        viaDiameter: this.config.viaDiameter,
        viaHoleDiameter: this.config.viaHoleDiameter,
        clearance: this.config.clearance,
        compactBusTracks: this.config.compactBusTracks,
        allowSameNetMerges: this.config.allowSameNetMerges,
        staticClearanceCache: this.routeStaticClearanceCache,
        blockingBusCounts: currentBusBlockingCounts,
      })
      if (!busPlans) {
        failedBusIds.push(bus.busId)
        for (const [blockingBusId, count] of currentBusBlockingCounts) {
          blockingBusCounts.set(
            blockingBusId,
            (blockingBusCounts.get(blockingBusId) ?? 0) + count,
          )
        }
      } else {
        plans.push(...busPlans)
      }
      this.routingPrefixCache.set(routingPrefixKey, {
        plans: [...plans],
        failedBusIds: [...failedBusIds],
        blockingBusCounts: new Map(blockingBusCounts),
      })
    }

    let validationIssues: FanoutAttemptSummary["validationIssues"]
    let outputSrj = buildOutputSimpleRouteJson({
      inputSrj: this.inputSrj,
      plans,
      layerNames: this.config.layerNames,
    })
    const validation =
      plans.length === this.inputSrj.connections.length
        ? this.validateCompletePlans(plans, outputSrj)
        : null
    if (validation && !validation.valid) {
      // Every route-producing strategy must pass the same final layer-aware,
      // same-net-aware copper validation before it can be scored as complete.
      validationIssues = validation.issues
      plans = []
      failedBusIds = this.preparedBuses.map((bus) => bus.busId)
      blockingBusCounts.clear()
      outputSrj = buildOutputSimpleRouteJson({
        inputSrj: this.inputSrj,
        plans,
        layerNames: this.config.layerNames,
      })
    }

    const routedBusCount = this.preparedBuses.length - failedBusIds.length
    const routeLength = plans.reduce((total, plan) => total + plan.length, 0)
    const unroutedConnectionCount =
      this.inputSrj.connections.length - plans.length
    const score =
      unroutedConnectionCount * 1_000_000 +
      failedBusIds.length * 100_000 +
      routeLength +
      getPlanViaCount(plans) * 0.1 +
      assignmentLoadPenalty(
        busLayerAssignments,
        this.preparedBuses,
        this.config.balanceLayerLoadByConnectionCount,
      ) *
        getLayerLoadPenaltyWeight(this.config)
    const summary: FanoutAttemptSummary = {
      assignmentIndex,
      busLayerAssignments,
      routedBusCount,
      routedConnectionCount: plans.length,
      failedBusIds,
      score,
      ...(validationIssues ? { validationIssues } : {}),
    }

    return {
      summary,
      plans,
      blockingBusIds: [...blockingBusCounts.entries()]
        .toSorted(([, firstCount], [, secondCount]) => secondCount - firstCount)
        .map(([busId]) => busId),
      outputSrj,
    }
  }

  private evaluateAssignment(
    assignmentIndex: number,
    busLayerAssignments: Readonly<Record<string, string>>,
  ): EvaluatedAssignment {
    let bestAttempt = this.evaluateAssignmentWithStrategy(
      assignmentIndex,
      busLayerAssignments,
      "default",
    )
    if (
      bestAttempt.summary.routedConnectionCount ===
      this.inputSrj.connections.length
    ) {
      return bestAttempt
    }

    for (const routingStrategy of ["group-by-layer", "deep-first"] as const) {
      const attempt = this.evaluateAssignmentWithStrategy(
        assignmentIndex,
        busLayerAssignments,
        routingStrategy,
      )
      if (attempt.summary.score < bestAttempt.summary.score) {
        bestAttempt = attempt
      }
      if (
        bestAttempt.summary.routedConnectionCount ===
        this.inputSrj.connections.length
      ) {
        return bestAttempt
      }
    }
    return bestAttempt
  }

  /**
   * Search layer assignments and track alternatives together. The regular
   * assignment loop commits to one route per bus before the next bus is
   * considered, so a locally-valid track can still starve a later bus. A
   * bounded beam keeps several grouped-layer route prefixes alive. It also
   * evaluates multi-connection buses atomically, so one promising route for a
   * power or signal lane cannot starve a later bus before the solver explores
   * an alternate layer/track combination.
   */
  private evaluateGroupedBeam(
    assignmentIndex: number,
    groupByDirection = false,
  ): EvaluatedAssignment | null {
    if (this.config.escapeLayers.length < 2) return null
    if (this.preparedBuses.length > 56) return null
    const totalConnections = this.inputSrj.connections.length
    // Multi-pin alternatives grow with both the bus width and the number of
    // layer prefixes. Keep the new search bounded on the small/medium grouped
    // problems it can improve, then let the regular assignment/repair search
    // handle the very large benchmark samples without starving them.
    if (totalConnections > 64) return null
    if (new Set(this.preparedBuses.map((bus) => bus.componentId)).size !== 1) {
      return null
    }

    const busesInSearchOrder = [...this.preparedBuses].sort((a, b) => {
      const aLayerCount =
        a.termination.type === "plane"
          ? 1
          : (this.escapeLayersByBusId[a.busId]?.length ??
            this.config.escapeLayers.length)
      const bLayerCount =
        b.termination.type === "plane"
          ? 1
          : (this.escapeLayersByBusId[b.busId]?.length ??
            this.config.escapeLayers.length)
      return (
        Number(b.termination.type === "plane") -
          Number(a.termination.type === "plane") ||
        (groupByDirection ? a.direction.localeCompare(b.direction) : 0) ||
        aLayerCount - bLayerCount ||
        b.componentObstacles.length - a.componentObstacles.length ||
        b.connections.length - a.connections.length ||
        getBusDepthInRows(b) - getBusDepthInRows(a) ||
        a.busId.localeCompare(b.busId)
      )
    })

    const isSmallProblem = totalConnections <= 24
    const hasMultiConnectionBus = this.preparedBuses.some(
      (bus) => bus.connections.length > 1,
    )
    // Preserve the broad track search for small singleton problems. Grouped
    // power buses already branch across every candidate layer and make each
    // route-alternative expansion combinatorial, so retain layer diversity but
    // only one atomic route per layer for those buses.
    const beamWidth = isSmallProblem ? 48 : totalConnections <= 32 ? 24 : 12
    const alternativesPerLayer =
      isSmallProblem && !hasMultiConnectionBus ? 4 : 1
    let states: GroupedBeamState[] = [{ assignment: {}, plans: [] }]

    const getStateScore = (state: GroupedBeamState): number => {
      const routeLength = state.plans.reduce(
        (total, plan) => total + plan.length,
        0,
      )
      const viaCount = getPlanViaCount(state.plans)
      const offEndpointLayerConnectionCount = this.preparedBuses.reduce(
        (count, bus) => {
          if (
            bus.termination.type !== "boundary" ||
            !busUsesDestinationGuidedTracks(bus)
          ) {
            return count
          }
          const sourceLayer = bus.connections[0]?.sourceLayer
          return state.assignment[bus.busId] === sourceLayer
            ? count
            : count + bus.connections.length
        },
        0,
      )
      return (
        routeLength +
        viaCount * 0.1 +
        offEndpointLayerConnectionCount * 10_000 +
        assignmentLoadPenalty(
          state.assignment,
          this.preparedBuses,
          this.config.balanceLayerLoadByConnectionCount,
        ) *
          getLayerLoadPenaltyWeight(this.config)
      )
    }

    for (const bus of busesInSearchOrder) {
      const nextStates: GroupedBeamState[] = []
      for (const state of states) {
        const candidateLayers =
          bus.termination.type === "plane"
            ? [bus.termination.layer]
            : (this.escapeLayersByBusId[bus.busId] ?? this.config.escapeLayers)
        const layerLoads = new Map<string, number>()
        for (const [assignedBusId, layer] of Object.entries(state.assignment)) {
          const assignedBus = this.preparedBuses.find(
            (candidate) => candidate.busId === assignedBusId,
          )
          layerLoads.set(
            layer,
            (layerLoads.get(layer) ?? 0) +
              (this.config.balanceLayerLoadByConnectionCount
                ? (assignedBus?.connections.length ?? 1)
                : 1),
          )
        }
        const sourceLayer = bus.connections[0]?.sourceLayer
        const preferSourceLayer = busUsesDestinationGuidedTracks(bus)
        const orderedLayers = candidateLayers.toSorted(
          (first, second) =>
            (layerLoads.get(first) ?? 0) - (layerLoads.get(second) ?? 0) ||
            (preferSourceLayer
              ? Number(second === sourceLayer) - Number(first === sourceLayer)
              : Number(first === sourceLayer) -
                Number(second === sourceLayer)) ||
            first.localeCompare(second),
        )

        for (const targetLayer of orderedLayers) {
          const busAlternatives = routeBusAlternatives(
            {
              srj: this.inputSrj,
              bus,
              targetLayer,
              acceptedPlans: state.plans,
              layerNames: this.config.layerNames,
              traceWidth: this.config.traceWidth,
              viaDiameter: this.config.viaDiameter,
              viaHoleDiameter: this.config.viaHoleDiameter,
              clearance: this.config.clearance,
              compactBusTracks: this.config.compactBusTracks,
              allowSameNetMerges: this.config.allowSameNetMerges,
              staticClearanceCache: this.routeStaticClearanceCache,
            },
            alternativesPerLayer,
          )
          for (const busPlans of busAlternatives) {
            nextStates.push({
              assignment: {
                ...state.assignment,
                [bus.busId]: targetLayer,
              },
              plans: [...state.plans, ...busPlans],
            })
          }
        }
      }

      if (nextStates.length === 0) return null
      nextStates.sort((first, second) => {
        const scoreDifference = getStateScore(first) - getStateScore(second)
        if (Math.abs(scoreDifference) > 1e-9) return scoreDifference
        return JSON.stringify(first.assignment).localeCompare(
          JSON.stringify(second.assignment),
        )
      })
      const statesByAssignment = new Map<string, number>()
      states = []
      for (const state of nextStates) {
        const key = JSON.stringify(state.assignment)
        const sameAssignmentCount = statesByAssignment.get(key) ?? 0
        if (sameAssignmentCount >= 2) continue
        statesByAssignment.set(key, sameAssignmentCount + 1)
        states.push(state)
        if (states.length >= beamWidth) break
      }
    }

    const bestState = states[0]
    if (!bestState) return null
    const outputSrj = buildOutputSimpleRouteJson({
      inputSrj: this.inputSrj,
      plans: bestState.plans,
      layerNames: this.config.layerNames,
    })
    if (
      bestState.plans.length === this.inputSrj.connections.length &&
      !this.validateCompletePlans(bestState.plans, outputSrj).valid
    ) {
      return null
    }
    const score =
      bestState.plans.length === this.inputSrj.connections.length
        ? bestState.plans.reduce((total, plan) => total + plan.length, 0) +
          getPlanViaCount(bestState.plans) * 0.1 +
          assignmentLoadPenalty(
            bestState.assignment,
            this.preparedBuses,
            this.config.balanceLayerLoadByConnectionCount,
          ) *
            getLayerLoadPenaltyWeight(this.config)
        : Number.POSITIVE_INFINITY
    if (!Number.isFinite(score)) return null

    const summary: FanoutAttemptSummary = {
      assignmentIndex,
      busLayerAssignments: bestState.assignment,
      routedBusCount: this.preparedBuses.length,
      routedConnectionCount: bestState.plans.length,
      failedBusIds: [],
      score,
    }
    return {
      summary,
      plans: bestState.plans,
      blockingBusIds: [],
      outputSrj,
    }
  }

  private prioritizeFailedBusRepairs(
    assignment: Readonly<Record<string, string>>,
    failedBusIds: readonly string[],
    blockingBusIds: readonly string[],
  ): void {
    const assignmentKey = JSON.stringify(assignment)
    const repairDepth = this.assignmentRepairDepthByKey.get(assignmentKey) ?? 0
    if (repairDepth >= 2) return

    const maximumRepairs = 8
    const repairs: Array<Readonly<Record<string, string>>> = []
    const repairKeys = new Set<string>()
    const addRepair = (repair: Readonly<Record<string, string>>): void => {
      const key = JSON.stringify(repair)
      if (
        repairKeys.has(key) ||
        this.evaluatedAssignmentKeys.has(key) ||
        this.queuedAssignmentKeys.has(key)
      ) {
        return
      }
      repairKeys.add(key)
      this.queuedAssignmentKeys.add(key)
      this.assignmentRepairDepthByKey.set(key, repairDepth + 1)
      repairs.push(repair)
    }
    const repairBusIds: string[] = []
    for (
      let index = 0;
      index < Math.max(failedBusIds.length, blockingBusIds.length);
      index++
    ) {
      const failedBusId = failedBusIds[index]
      const blockingBusId = blockingBusIds[index]
      if (failedBusId && !repairBusIds.includes(failedBusId)) {
        repairBusIds.push(failedBusId)
      }
      if (blockingBusId && !repairBusIds.includes(blockingBusId)) {
        repairBusIds.push(blockingBusId)
      }
    }

    for (const failedBusId of failedBusIds) {
      const failedLayer = assignment[failedBusId]
      const failedCandidateLayers = this.escapeLayersByBusId[failedBusId]
      if (!failedLayer || !failedCandidateLayers) continue
      for (const blockingBusId of blockingBusIds.slice(0, 4)) {
        const blockingLayer = assignment[blockingBusId]
        const blockingCandidateLayers = this.escapeLayersByBusId[blockingBusId]
        if (
          !blockingLayer ||
          !blockingCandidateLayers ||
          !failedCandidateLayers.includes(blockingLayer) ||
          !blockingCandidateLayers.includes(failedLayer)
        ) {
          continue
        }
        addRepair({
          ...assignment,
          [failedBusId]: blockingLayer,
          [blockingBusId]: failedLayer,
        })
        if (repairs.length >= maximumRepairs) break
      }
      if (repairs.length >= maximumRepairs) break
    }

    for (const busId of repairBusIds) {
      const currentLayer = assignment[busId]
      const candidateLayers = this.escapeLayersByBusId[busId]
      if (!currentLayer || !candidateLayers) continue
      const currentLayerIndex = candidateLayers.indexOf(currentLayer)
      for (let shift = 1; shift < candidateLayers.length; shift++) {
        const candidateLayer =
          candidateLayers[
            (Math.max(currentLayerIndex, 0) + shift) % candidateLayers.length
          ]!
        if (candidateLayer === currentLayer) continue
        addRepair({ ...assignment, [busId]: candidateLayer })
        if (repairs.length >= maximumRepairs) break
      }
      if (repairs.length >= maximumRepairs) break
    }
    this.pendingRepairAssignments.push(...repairs)
  }

  private hasCompleteBestAttempt(): boolean {
    return (
      this.bestAttempt?.summary.routedConnectionCount ===
      this.inputSrj.connections.length
    )
  }

  private shouldEvaluateGroupedBeam(): boolean {
    if (this.groupedBeamEvaluated || this.nextAssignmentIndex === 0) {
      return false
    }

    const targetedRepairSearchFinished =
      this.hasCompleteBestAttempt() ||
      this.pendingRepairAssignments.length === 0 ||
      this.nextAssignmentIndex >= this.config.maxLayerCombinations

    return targetedRepairSearchFinished
  }

  override _step(): void {
    // Try the deterministic assignment and only its targeted repair queue
    // before paying for the grouped beam. If the beam cannot solve, continue
    // with the broader generated-assignment search below.
    if (this.shouldEvaluateGroupedBeam()) {
      this.groupedBeamEvaluated = true
      let beamAttempt = this.evaluateGroupedBeam(-1)
      if (!beamAttempt) {
        beamAttempt = this.evaluateGroupedBeam(-1, true)
      }
      if (beamAttempt) {
        this.attempts.push(beamAttempt.summary)
        if (
          !this.bestAttempt ||
          beamAttempt.summary.score < this.bestAttempt.summary.score
        ) {
          this.bestAttempt = beamAttempt
        }
        const bestSummary = this.bestAttempt.summary
        this.stats = {
          assignment:
            bestSummary.assignmentIndex < 0
              ? 0
              : bestSummary.assignmentIndex + 1,
          assignmentCount: this.config.maxLayerCombinations,
          routedBuses: `${bestSummary.routedBusCount}/${this.preparedBuses.length}`,
          routedConnections: `${bestSummary.routedConnectionCount}/${this.inputSrj.connections.length}`,
          failedBuses: "none",
          bestScore: bestSummary.score,
        }
        this.completeBestAttemptEndpoints()
        this.solved = true
        return
      }
      if (this.hasCompleteBestAttempt()) {
        this.completeBestAttemptEndpoints()
        this.solved = true
        return
      }
    }

    let assignment: Readonly<Record<string, string>> | undefined
    while (
      !assignment &&
      this.nextAssignmentIndex < this.config.maxLayerCombinations
    ) {
      const preferGeneratedAssignment = this.nextAssignmentIndex % 3 === 0
      let candidate: Readonly<Record<string, string>> | undefined
      let candidateCameFromRepairQueue = false
      if (!this.groupedBeamEvaluated && this.nextAssignmentIndex > 0) {
        candidate = this.pendingRepairAssignments.pop()
        candidateCameFromRepairQueue = candidate !== undefined
      } else if (preferGeneratedAssignment) {
        candidate = this.layerAssignments[this.nextGeneratedAssignmentIndex++]
      } else {
        candidate = this.pendingRepairAssignments.pop()
        candidateCameFromRepairQueue = candidate !== undefined
      }
      if (
        !candidate &&
        (this.groupedBeamEvaluated || this.nextAssignmentIndex === 0)
      ) {
        candidate = preferGeneratedAssignment
          ? this.pendingRepairAssignments.pop()
          : this.layerAssignments[this.nextGeneratedAssignmentIndex++]
        candidateCameFromRepairQueue =
          preferGeneratedAssignment && candidate !== undefined
      }
      if (!candidate) break
      const candidateKey = JSON.stringify(candidate)
      if (candidateCameFromRepairQueue) {
        this.queuedAssignmentKeys.delete(candidateKey)
      }
      if (this.evaluatedAssignmentKeys.has(candidateKey)) continue
      assignment = candidate
    }
    if (!assignment && !this.groupedBeamEvaluated) return
    if (!assignment) {
      if (this.hasCompleteBestAttempt()) {
        this.completeBestAttemptEndpoints()
        this.solved = true
      } else {
        this.failed = true
        this.error = this.bestAttempt
          ? `FanoutSolver: best layer assignment routed ${this.bestAttempt.summary.routedConnectionCount}/${this.inputSrj.connections.length} connections`
          : "FanoutSolver: no layer assignment could be evaluated"
      }
      return
    }

    const attempt = this.evaluateAssignment(
      this.nextAssignmentIndex,
      assignment,
    )
    this.nextAssignmentIndex++
    this.evaluatedAssignmentKeys.add(JSON.stringify(assignment))
    if (
      !this.bestAttempt ||
      attempt.summary.routedConnectionCount >=
        this.bestAttempt.summary.routedConnectionCount
    ) {
      this.prioritizeFailedBusRepairs(
        assignment,
        attempt.summary.failedBusIds,
        attempt.blockingBusIds,
      )
    }
    this.attempts.push(attempt.summary)
    if (
      !this.bestAttempt ||
      attempt.summary.score < this.bestAttempt.summary.score
    ) {
      this.bestAttempt = attempt
    }
    this.stats = {
      assignment: attempt.summary.assignmentIndex + 1,
      assignmentCount: this.config.maxLayerCombinations,
      routedBuses: `${attempt.summary.routedBusCount}/${this.preparedBuses.length}`,
      routedConnections: `${attempt.summary.routedConnectionCount}/${this.inputSrj.connections.length}`,
      failedBuses: attempt.summary.failedBusIds.join(", ") || "none",
      bestScore: this.bestAttempt.summary.score,
    }
    if (
      this.groupedBeamEvaluated &&
      attempt.summary.routedConnectionCount === this.inputSrj.connections.length
    ) {
      this.completeBestAttemptEndpoints()
      this.solved = true
    }
  }

  computeProgress(): number {
    if (this.solved || this.failed) return 1
    return this.nextAssignmentIndex / this.config.maxLayerCombinations
  }

  override getConstructorParams(): [SimpleRouteJson, FanoutSolverOptions] {
    return [this.inputSrj, this.options]
  }

  override getOutput(): FanoutSolverOutput {
    if (!this.solved || !this.bestAttempt) {
      throw new Error(
        "FanoutSolver: getOutput() called before a complete fanout was solved",
      )
    }
    const validation = this.validateCompletePlans(
      this.bestAttempt.plans,
      this.bestAttempt.outputSrj,
    )
    if (!validation.valid) {
      throw new Error(
        `FanoutSolver: completed output failed validation: ${validation.issues[0]?.message ?? "unknown validation error"}`,
      )
    }
    const finalSrj =
      this.endpointCompletion?.simpleRouteJson ?? this.bestAttempt.outputSrj
    const finalTraceById = new Map(
      (finalSrj.traces ?? []).map((trace) => [trace.pcb_trace_id, trace]),
    )
    return {
      simpleRouteJson:
        this.endpointCompletion?.simpleRouteJson ?? this.bestAttempt.outputSrj,
      fanoutTraces: this.bestAttempt.plans.flatMap((plan) => [
        finalTraceById.get(plan.trace.pcb_trace_id) ?? plan.trace,
        ...(plan.planeEndpointTrace
          ? [
              finalTraceById.get(plan.planeEndpointTrace.pcb_trace_id) ??
                plan.planeEndpointTrace,
            ]
          : []),
      ]),
      completionTraces: this.endpointCompletion?.traces ?? [],
      ...(this.endpointCompletion
        ? { endpointCompletion: this.endpointCompletion.report }
        : {}),
      planeTerminations: this.bestAttempt.plans.flatMap((plan) =>
        plan.termination.type === "plane" && plan.via
          ? [
              {
                busId: plan.busId,
                connectionName: plan.connectionName,
                layer: plan.termination.layer,
                via: plan.via,
              },
            ]
          : [],
      ),
      busLayerAssignments: this.bestAttempt.summary.busLayerAssignments,
      busDirections: Object.fromEntries(
        this.preparedBuses.map((bus) => [bus.busId, bus.direction]),
      ),
      attempts: [...this.attempts],
      validation,
    }
  }

  getOutputSimpleRouteJson(): SimpleRouteJson {
    return this.getOutput().simpleRouteJson
  }

  override visualize(): GraphicsObject {
    const visualizedSrj =
      this.endpointCompletion?.simpleRouteJson ??
      this.bestAttempt?.outputSrj ??
      this.inputSrj
    return visualizeSimpleRouteJson(visualizedSrj)
  }
}
