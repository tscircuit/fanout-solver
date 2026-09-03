import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { BaseSolver } from "@tscircuit/solver-utils"
import { type GraphicsObject, mergeGraphics } from "graphics-debug"
import { addViaLayerMetadataToSrj } from "./add-via-layer-metadata"
import { getCornerBandSide, getExitEdgeForDirection } from "./boundary-exit"
import { buildOutputSimpleRouteJson } from "./build-output"
import {
  type CompleteOriginalEndpointsResult,
  completeOriginalEndpoints,
} from "./complete-original-endpoints"
import {
  generateLayerAssignments,
  getCopperLayerNames,
  getViaSpanLayers,
} from "./layer-names"
import { matchBusPlanLengths } from "./match-bus-lengths"
import {
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaSites,
} from "./match-component-dogbone-via-sites"
import { connectionsShareElectricalNet } from "./net-identity"
import {
  prepareFanoutBuses,
  resolveAvailableBoundaryRegions,
} from "./prepare-buses"
import {
  fanoutPlansAreClear,
  fanoutPlansAreMutuallyClear,
  type RouteBusStaticClearanceCache,
  routeBus,
  routeBusAlternatives,
  routeBusAlternativesSteps,
} from "./route-bus"
import { routeSingleLayerWithAdaptiveExitsSteps } from "./route-single-layer-adaptive-exits"
import { routeSingleLayerWithPushAndShove } from "./route-single-layer-push-shove"
import type {
  AssignmentAttempt,
  Bounds,
  FanoutAttemptSummary,
  FanoutBorderDistribution,
  FanoutRoutePlan,
  FanoutSolverOptions,
  FanoutSolverOutput,
  FanoutValidationIssue,
  PreparedBus,
  SimpleRouteJsonWithFanoutPlanes,
} from "./types"
import { validateFanoutSolution } from "./validate-fanout-solution"
import { visualizeSimpleRouteJson } from "./visualize-simple-route-json"

interface ResolvedFanoutConfig {
  traceWidth: number
  viaDiameter: number
  viaHoleDiameter: number
  clearance: number
  compactBusTracks: boolean
  allowBlindAndBuriedVias: boolean
  allowSameNetMerges: boolean
  densePlaneReservationBusIds: readonly string[]
  denseUnrestrictedPlaneRoutingBusIds: readonly string[]
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

interface MixedTerminationState {
  plans: FanoutRoutePlan[]
  failedBusIds: string[]
}

type RoutingStrategy = "default" | "group-by-layer" | "deep-first"

interface FanoutSubsolverRequest {
  type: "subsolver"
  solver: BaseSolver
}

type FanoutWorkYield = undefined | FanoutSubsolverRequest

class FanoutWorkSolver<T> extends BaseSolver {
  private output: T | undefined
  private hasOutput = false
  private nextInput: unknown

  constructor(
    private readonly solverName: string,
    private readonly generator: Generator<unknown, T, unknown>,
    private readonly getVisualization: () => GraphicsObject,
    private readonly getStats: () => Record<string, unknown>,
    private readonly getProgress: () => number,
  ) {
    super()
    this.MAX_ITERATIONS = 1_000_000
  }

  override getSolverName(): string {
    return this.solverName
  }

  override _step(): void {
    if (this.activeSubSolver) {
      this.activeSubSolver.step()
      if (this.activeSubSolver.failed) {
        this.failedSubSolvers = [
          ...(this.failedSubSolvers ?? []),
          this.activeSubSolver,
        ]
        this.error = this.activeSubSolver.error
        this.failed = true
        this.activeSubSolver = null
        return
      }
      if (this.activeSubSolver.solved) {
        this.nextInput = this.activeSubSolver.getOutput()
        this.activeSubSolver = null
      }
      this.stats = this.getStats()
      return
    }

    const result = this.generator.next(this.nextInput)
    this.nextInput = undefined
    this.stats = this.getStats()
    if (result.done) {
      this.output = result.value
      this.hasOutput = true
      this.solved = true
      return
    }
    const yielded = result.value as Partial<FanoutSubsolverRequest> | undefined
    if (yielded?.type === "subsolver" && yielded.solver instanceof BaseSolver) {
      this.activeSubSolver = yielded.solver
    }
  }

  computeProgress(): number {
    return this.getProgress()
  }

  override getConstructorParams(): [] {
    return []
  }

  override getOutput(): T {
    if (!this.solved || !this.hasOutput) {
      throw new Error(`${this.solverName}: output requested before completion`)
    }
    return this.output as T
  }

  override visualize(): GraphicsObject {
    return this.activeSubSolver?.visualize() ?? this.getVisualization()
  }
}

interface ActiveFanoutOperation<T> {
  solver: FanoutWorkSolver<T>
  onSolved: (output: T) => void
}

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
    allowBlindAndBuriedVias: options.allowBlindAndBuriedVias ?? true,
    allowSameNetMerges: options.allowSameNetMerges ?? false,
    densePlaneReservationBusIds: options.densePlaneReservationBusIds ?? [],
    denseUnrestrictedPlaneRoutingBusIds:
      options.denseUnrestrictedPlaneRoutingBusIds ?? [],
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

function validateCornerBandCapacities(
  buses: readonly PreparedBus[],
  config: ResolvedFanoutConfig,
): void {
  const checkedBands = new Set<string>()
  const exitPitch = Math.max(
    config.traceWidth + config.clearance,
    config.viaDiameter + config.clearance,
  )
  // Keep the block clear of the physical end of the edge and leave one
  // unoccupied via-pitch between the minimum and maximum quarter bands.
  const endInset = Math.max(
    config.viaDiameter / 2 + config.clearance,
    exitPitch,
  )

  for (const bus of buses) {
    const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    if (!bus.exitEdge || !side) continue
    const bandKey = `${bus.exitEdge}:${side}`
    if (checkedBands.has(bandKey)) continue
    checkedBands.add(bandKey)

    const edgeLength =
      bus.exitEdge === "left" || bus.exitEdge === "right"
        ? bus.sharedBoundary.maxY - bus.sharedBoundary.minY
        : bus.sharedBoundary.maxX - bus.sharedBoundary.minX
    const connectionCount =
      bus.cornerBandConnectionCount ?? bus.connections.length
    const halfTrackSpan = ((connectionCount - 1) * exitPitch) / 2
    const availableHalfTrackSpan = edgeLength / 4 - endInset
    if (halfTrackSpan > availableHalfTrackSpan + 1e-6) {
      throw new Error(
        `FanoutSolver: ${side} band on the ${bus.exitEdge} edge cannot fit ${connectionCount} via-safe exits`,
      )
    }
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

function comparePlaneRoutingPriority(
  first: PreparedBus,
  second: PreparedBus,
  allowBlindAndBuriedVias: boolean,
): number {
  const planeDifference =
    Number(first.termination.type === "plane") -
    Number(second.termination.type === "plane")
  return allowBlindAndBuriedVias ? -planeDifference : planeDifference
}

function getPlanViaCount(plans: readonly FanoutRoutePlan[]): number {
  return plans.reduce(
    (count, plan) =>
      count +
      Number(Boolean(plan.via)) +
      (plan.additionalVias?.length ?? 0) +
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

function getCommonExplicitExitTargetLayer(
  bus: PreparedBus,
): string | undefined {
  if (
    bus.connections.length === 0 ||
    bus.connections.some(
      (connection) =>
        !connection.hasExplicitLayeredExitTarget ||
        !connection.exitTargetPoint?.layer,
    )
  ) {
    return undefined
  }
  const targetLayers = new Set(
    bus.connections.map((connection) => connection.exitTargetPoint!.layer!),
  )
  if (targetLayers.size !== 1) return undefined
  const [targetLayer] = targetLayers
  return targetLayer
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
  preferOrderedCoordinatedWindingLayers: boolean
}): Readonly<Record<string, string>> {
  const {
    buses,
    escapeLayers,
    escapeLayersByBusId,
    preferOrderedCoordinatedWindingLayers,
  } = params
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
    const commonExitTargetLayer = getCommonExplicitExitTargetLayer(bus)
    if (
      commonExitTargetLayer &&
      routableEscapeLayers.includes(commonExitTargetLayer)
    ) {
      assignment[bus.busId] = commonExitTargetLayer
    } else if (
      !busUsesCoordinatedWinding(bus) &&
      routableEscapeLayers.includes(sourceLayer) &&
      (busUsesDestinationGuidedTracks(bus) || busIsOnOutwardComponentEdge(bus))
    ) {
      assignment[bus.busId] = sourceLayer
    } else if (viaLayers.length > 0) {
      if (
        preferOrderedCoordinatedWindingLayers &&
        busUsesCoordinatedWinding(bus)
      ) {
        // Coordinated winding treats allowedLayers as an ordered preference.
        // A global round-robin index can otherwise skip a bus's first choice
        // just because a previous bus had a different set of legal layers.
        assignment[bus.busId] = viaLayers[0]!
        continue
      }
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

function busUsesCoordinatedWinding(bus: PreparedBus): boolean {
  return Boolean(
    bus.exitEdge &&
      bus.termination.type === "boundary" &&
      bus.connections.length > 0 &&
      bus.connections.every(
        (connection) => connection.hasExplicitLayeredExitTarget === true,
      ),
  )
}

export function shouldUseJointBoundaryViaReservation(
  boundaryBusConnectionCounts: readonly number[],
): boolean {
  return (
    boundaryBusConnectionCounts.length === 5 ||
    boundaryBusConnectionCounts.length === 6 ||
    boundaryBusConnectionCounts.length === 7 ||
    boundaryBusConnectionCounts.length === 8 ||
    boundaryBusConnectionCounts.length === 9 ||
    (boundaryBusConnectionCounts.length === 4 &&
      new Set(boundaryBusConnectionCounts).size > 1)
  )
}

export function shouldDeferSingletonBoundaryViaReservation(
  boundaryBusConnectionCounts: readonly number[],
): boolean {
  const boundaryBusCount = boundaryBusConnectionCounts.length
  const singletonBusCount = boundaryBusConnectionCounts.filter(
    (count) => count === 1,
  ).length
  return (
    ((boundaryBusCount === 5 ||
      boundaryBusCount === 6 ||
      boundaryBusCount === 7) &&
      singletonBusCount === 1) ||
    (boundaryBusCount === 8 &&
      (singletonBusCount === 1 || singletonBusCount === 2)) ||
    (boundaryBusCount === 9 && singletonBusCount >= 1 && singletonBusCount <= 3)
  )
}

export function getDenseSingletonDeferralCandidateCount(
  boundaryBusConnectionCounts: readonly number[],
): number {
  if (
    !shouldDeferSingletonBoundaryViaReservation(boundaryBusConnectionCounts)
  ) {
    return 0
  }
  const singletonBusCount = boundaryBusConnectionCounts.filter(
    (count) => count === 1,
  ).length
  return Math.max(1, singletonBusCount - 1)
}

interface DenseSourceFieldBus {
  componentId: string
  exitEdge?: PreparedBus["exitEdge"]
  allowedLayers?: readonly string[]
  routableEscapeLayers?: readonly string[]
  connections: readonly { sourcePoint: { x: number; y: number } }[]
}

export function isDenseSingletonEmbeddedInMultiLayerWideBus(params: {
  singletonBus: DenseSourceFieldBus
  singletonTargetLayer: string
  wideBuses: readonly DenseSourceFieldBus[]
}): boolean {
  const sourcePoint = params.singletonBus.connections[0]?.sourcePoint
  if (params.singletonBus.connections.length !== 1 || !sourcePoint) return false
  return params.wideBuses.some((wideBus) => {
    const wideLayers =
      wideBus.routableEscapeLayers ?? wideBus.allowedLayers ?? []
    if (
      wideBus.connections.length < 8 ||
      wideBus.componentId !== params.singletonBus.componentId ||
      wideBus.exitEdge !== params.singletonBus.exitEdge ||
      wideLayers.length < 2 ||
      !wideLayers.includes(params.singletonTargetLayer)
    ) {
      return false
    }
    const sourceXs = wideBus.connections.map(
      (connection) => connection.sourcePoint.x,
    )
    const sourceYs = wideBus.connections.map(
      (connection) => connection.sourcePoint.y,
    )
    return (
      sourcePoint.x >= Math.min(...sourceXs) - 1e-9 &&
      sourcePoint.x <= Math.max(...sourceXs) + 1e-9 &&
      sourcePoint.y >= Math.min(...sourceYs) - 1e-9 &&
      sourcePoint.y <= Math.max(...sourceYs) + 1e-9
    )
  })
}

export function getDenseLeadingCornerBandTargetTrackOffset(params: {
  leadingLaneCount: number
  traceWidth: number
  viaDiameter: number
  clearance: number
}): number {
  const cornerPitch = Math.max(
    params.traceWidth + params.clearance,
    params.viaDiameter + params.clearance,
  )
  return (-params.leadingLaneCount * cornerPitch) / 2
}

export function shouldSearchAdditionalBoundaryRouteTopologies(params: {
  boundaryBusCount: number
  connectionCount: number
  rawSkew: number
  maximumSkew: number
}): boolean {
  if (params.boundaryBusCount === 5 || params.boundaryBusCount > 9) {
    return false
  }
  if (
    params.boundaryBusCount === 6 ||
    params.boundaryBusCount === 7 ||
    params.boundaryBusCount === 8 ||
    params.boundaryBusCount === 9
  ) {
    // Six through nine buses remove enough meander space that a severely skewed wide
    // topology can be impossible to tune. Keep the retry away from narrow
    // differential/control groups and from modest deficits that the atomic
    // length matcher can absorb directly.
    return (
      params.connectionCount > 2 &&
      params.rawSkew - params.maximumSkew >
        Math.max(1, params.maximumSkew * 0.5)
    )
  }
  return (
    params.rawSkew - params.maximumSkew > Math.max(1, params.maximumSkew * 0.25)
  )
}

interface DenseSingletonBoundaryGeometryBus {
  busId: string
  direction: PreparedBus["direction"]
  exitEdge?: PreparedBus["exitEdge"]
  preferredExit?: PreparedBus["preferredExit"]
  connections: readonly {
    sourcePoint: { x: number; y: number }
    exitTargetPoint?: { x: number; y: number }
  }[]
}

export function getDenseSingletonBoundaryGeometry(
  bus: DenseSingletonBoundaryGeometryBus,
): { isCorner: boolean; targetProjection: number } {
  const connection = bus.connections[0]
  const target = connection?.exitTargetPoint
  let targetProjection = 0
  if (connection && target) {
    const deltaX = target.x - connection.sourcePoint.x
    const deltaY = target.y - connection.sourcePoint.y
    targetProjection =
      bus.direction === "right"
        ? deltaX
        : bus.direction === "left"
          ? -deltaX
          : bus.direction === "up"
            ? deltaY
            : -deltaY
  }
  return {
    isCorner: Boolean(getCornerBandSide(bus.exitEdge, bus.preferredExit)),
    targetProjection,
  }
}

export function compareDenseSingletonBoundaryDeferralPriority(
  first: DenseSingletonBoundaryGeometryBus,
  second: DenseSingletonBoundaryGeometryBus,
): number {
  const firstGeometry = getDenseSingletonBoundaryGeometry(first)
  const secondGeometry = getDenseSingletonBoundaryGeometry(second)
  return (
    Number(firstGeometry.isCorner) - Number(secondGeometry.isCorner) ||
    (firstGeometry.isCorner && secondGeometry.isCorner
      ? firstGeometry.targetProjection - secondGeometry.targetProjection
      : 0) ||
    first.busId.localeCompare(second.busId)
  )
}

function compareReleasedDenseSingletonBoundaryDeferralPriority(
  first: DenseSingletonBoundaryGeometryBus,
  second: DenseSingletonBoundaryGeometryBus,
): number {
  const firstGeometry = getDenseSingletonBoundaryGeometry(first)
  const secondGeometry = getDenseSingletonBoundaryGeometry(second)
  return (
    Number(firstGeometry.isCorner) - Number(secondGeometry.isCorner) ||
    (firstGeometry.isCorner && secondGeometry.isCorner
      ? Number(firstGeometry.targetProjection > 0) -
        Number(secondGeometry.targetProjection > 0)
      : 0) ||
    first.busId.localeCompare(second.busId)
  )
}

interface DensePairRoutingPriorityBus {
  componentId: string
  exitEdge?: PreparedBus["exitEdge"]
  assignedLayer?: string
  connections: readonly {
    sourceLayer: string
    sourcePoint: { x: number; y: number }
    exitTargetPoint?: { x: number; y: number; layer?: string }
  }[]
}

export function getDenseBoundaryPairRoutingPriorityKeys(params: {
  boundaryBusCount: number
  pairBuses: readonly DensePairRoutingPriorityBus[]
}): number[] | null {
  const { pairBuses } = params
  const firstBus = pairBuses[0]
  const firstSourceLayer = firstBus?.connections[0]?.sourceLayer
  if (
    (params.boundaryBusCount !== 7 &&
      params.boundaryBusCount !== 8 &&
      params.boundaryBusCount !== 9) ||
    pairBuses.length !== 3 ||
    firstBus === undefined ||
    firstBus.exitEdge === undefined ||
    firstBus.assignedLayer === undefined ||
    firstSourceLayer === undefined ||
    pairBuses.some(
      (bus) =>
        bus.connections.length !== 2 ||
        bus.componentId !== firstBus.componentId ||
        bus.exitEdge !== firstBus.exitEdge ||
        bus.assignedLayer !== firstBus.assignedLayer ||
        bus.connections.some((connection) => {
          const exitTarget = connection.exitTargetPoint
          return (
            connection.sourceLayer !== firstSourceLayer ||
            exitTarget?.layer !== firstBus.assignedLayer ||
            !Number.isFinite(connection.sourcePoint.x) ||
            !Number.isFinite(connection.sourcePoint.y) ||
            !Number.isFinite(exitTarget?.x) ||
            !Number.isFinite(exitTarget?.y)
          )
        }),
    )
  ) {
    return null
  }

  const getMaximumSourceToExitTargetDistance = (
    bus: DensePairRoutingPriorityBus,
  ): number =>
    Math.max(
      ...bus.connections.map((connection) => {
        const exitTarget = connection.exitTargetPoint!
        return Math.hypot(
          exitTarget.x - connection.sourcePoint.x,
          exitTarget.y - connection.sourcePoint.y,
        )
      }),
    )
  // A pair is constrained by the lane with the farthest explicit reach. A
  // mean can hide that lane behind its shorter mate and reverse channel order.
  // Quantize once so equality is transitive. An epsilon-based pairwise
  // comparator can otherwise produce A = B, B = C, but A != C.
  return pairBuses.map((bus) =>
    Number(getMaximumSourceToExitTargetDistance(bus).toFixed(9)),
  )
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
  // A coordinated winding route is deliberately planned with the other buses'
  // committed escape vias present. Testing it in isolation is both expensive
  // and can reject a layer whose shared via field guides a valid bus ordering.
  if (busUsesCoordinatedWinding(bus)) return allowedEscapeLayers
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
        allowBlindAndBuriedVias: config.allowBlindAndBuriedVias,
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
  readonly preparedBuses: PreparedBus[]
  readonly attempts: FanoutAttemptSummary[] = []
  readonly layerAssignments: Array<Readonly<Record<string, string>>> = []
  readonly config: ResolvedFanoutConfig
  private readonly routingSrj: SimpleRouteJson
  private readonly escapeLayersByBusId: Record<string, readonly string[]> = {}
  private readonly boundaryBuses: PreparedBus[]
  private readonly fixedPlaneAssignments: Readonly<Record<string, string>>
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
  private routingInitialized = false
  private nextCandidateLayerBusIndex = 0
  private nextAssignmentIndex = 0
  private nextGeneratedAssignmentIndex = 0
  private activeOperation: ActiveFanoutOperation<unknown> | null = null
  private inProgressPlans: FanoutRoutePlan[] = []
  private activeRoutingVisualization: GraphicsObject | null = null
  private activeAdaptiveVisualization: GraphicsObject | null = null
  private bestAttempt: AssignmentAttempt | null = null
  private lengthMatchingFailure: FanoutValidationIssue | null = null
  private endpointCompletion: CompleteOriginalEndpointsResult | null = null

  constructor(
    public readonly inputSrj: SimpleRouteJson,
    public readonly options: FanoutSolverOptions = {},
  ) {
    super()
    this.routingSrj = {
      ...inputSrj,
      obstacles: [...inputSrj.obstacles],
    }
    this.config = resolveConfig(inputSrj, options)
    this.preparedBuses = prepareFanoutBuses(this.routingSrj, options)
    validateCornerBandCapacities(this.preparedBuses, this.config)
    for (const bus of this.preparedBuses) {
      for (const connection of bus.connections) {
        if (!connection.hasExplicitLayeredExitTarget) continue
        const targetLayer = connection.exitTargetPoint?.layer
        if (
          typeof targetLayer !== "string" ||
          targetLayer.length === 0 ||
          !this.config.layerNames.includes(targetLayer)
        ) {
          throw new Error(
            `FanoutSolver: connection exit target for "${connection.connection.name}" uses unavailable layer "${String(targetLayer)}"`,
          )
        }
      }
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
      bus.routableEscapeLayers = this.config.escapeLayers.filter(
        (layer) => bus.allowedLayers?.includes(layer) ?? true,
      )
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
    this.boundaryBuses = this.preparedBuses.filter(
      (bus) => bus.termination.type === "boundary",
    )
    this.fixedPlaneAssignments = Object.fromEntries(
      this.preparedBuses.flatMap((bus) =>
        bus.termination.type === "plane"
          ? [[bus.busId, bus.termination.layer] as const]
          : [],
      ),
    )
    const workUnitsPerAssignment = this.preparedBuses.length * 3 + 8
    const estimatedWorkUnitCount =
      this.boundaryBuses.length +
      1 +
      this.config.maxLayerCombinations * workUnitsPerAssignment +
      this.preparedBuses.length * 2 +
      20
    this.MAX_ITERATIONS = Math.max(10_000, estimatedWorkUnitCount)
  }

  override getSolverName(): string {
    return "FanoutSolver"
  }

  private stepRoutingInitialization(): void {
    const bus = this.boundaryBuses[this.nextCandidateLayerBusIndex]
    if (bus) {
      this.escapeLayersByBusId[bus.busId] = getCandidateEscapeLayersForBus({
        bus,
        srj: this.routingSrj,
        config: this.config,
        staticClearanceCache: this.routeStaticClearanceCache,
      })
      this.nextCandidateLayerBusIndex++
      this.stats = {
        phase: "discover-candidate-layers",
        bus: bus.busId,
        busIndex: this.nextCandidateLayerBusIndex,
        busCount: this.boundaryBuses.length,
      }
      return
    }

    const generatedAssignments = generateLayerAssignments({
      busIds: this.boundaryBuses.map((candidate) => candidate.busId),
      layers: this.config.escapeLayers,
      layersByBusId: this.escapeLayersByBusId,
      maxAssignments: this.config.maxLayerCombinations,
    }).map((assignment) => ({
      ...assignment,
      ...this.fixedPlaneAssignments,
    }))
    this.layerAssignments.push(
      ...prioritizeLayerAssignment({
        initialAssignment: createInitialLayerAssignment({
          buses: this.preparedBuses,
          escapeLayers: this.config.escapeLayers,
          escapeLayersByBusId: this.escapeLayersByBusId,
          preferOrderedCoordinatedWindingLayers:
            this.config.densePlaneReservationBusIds.length > 0 ||
            this.config.denseUnrestrictedPlaneRoutingBusIds.length > 0,
        }),
        generatedAssignments,
        maxAssignments: this.config.maxLayerCombinations,
      }),
    )
    this.routingInitialized = true
    this.stats = {
      phase: "prepare-layer-assignments",
      assignmentCount: this.layerAssignments.length,
    }
  }

  private *initializeRoutingSteps(): Generator<FanoutWorkYield, void, unknown> {
    while (!this.routingInitialized) {
      this.stepRoutingInitialization()
      if (!this.routingInitialized) yield
    }
  }

  private setInProgressPlans(params: {
    phase: string
    plans: readonly FanoutRoutePlan[]
    strategy?: RoutingStrategy | "grouped-beam"
    unitIndex?: number
    unitCount?: number
    busId?: string
  }): void {
    this.inProgressPlans = [...params.plans]
    this.stats = {
      ...this.stats,
      phase: params.phase,
      ...(params.strategy ? { routingStrategy: params.strategy } : {}),
      ...(params.unitIndex !== undefined ? { workUnit: params.unitIndex } : {}),
      ...(params.unitCount !== undefined
        ? { workUnitCount: params.unitCount }
        : {}),
      ...(params.busId ? { bus: params.busId } : {}),
      routedConnections: `${params.plans.length}/${this.inputSrj.connections.length}`,
    }
  }

  private visualizeCurrentState(): GraphicsObject {
    const visualizedSrj =
      this.endpointCompletion?.simpleRouteJson ??
      (!this.solved && !this.failed && this.inProgressPlans.length > 0
        ? buildOutputSimpleRouteJson({
            inputSrj: this.inputSrj,
            plans: this.inProgressPlans,
            layerNames: this.config.layerNames,
          })
        : undefined) ??
      this.bestAttempt?.outputSrj ??
      this.inputSrj
    return visualizeSimpleRouteJson(visualizedSrj)
  }

  private visualizeWorkState(solverName: string): GraphicsObject {
    const base = this.visualizeCurrentState()
    const boundary =
      this.preparedBuses[0]?.sharedBoundary ?? this.inputSrj.bounds
    const activeBusId =
      typeof this.stats.bus === "string" ? this.stats.bus : undefined
    const activeBus = activeBusId
      ? this.preparedBuses.find((bus) => bus.busId === activeBusId)
      : undefined
    const width = boundary.maxX - boundary.minX
    const height = boundary.maxY - boundary.minY
    const annotationSize = Math.max(Math.min(width, height) * 0.025, 0.25)
    const phase =
      typeof this.stats.phase === "string" ? this.stats.phase : "starting"
    const detail = [
      typeof this.stats.routeConnection === "string"
        ? `connection ${this.stats.routeConnection}`
        : undefined,
      typeof this.stats.searchBatch === "number"
        ? `batch ${this.stats.searchBatch}`
        : undefined,
      typeof this.stats.expandedStates === "number"
        ? `${this.stats.expandedStates.toLocaleString()} states`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ")
    const title = `${solverName}: ${phase}`
    return {
      ...mergeGraphics(base, {
        rects: [
          {
            center: {
              x: (boundary.minX + boundary.maxX) / 2,
              y: (boundary.minY + boundary.maxY) / 2,
            },
            width,
            height,
            fill: "rgba(0, 0, 0, 0)",
            stroke: "rgba(14, 165, 233, 0.8)",
            label: `${solverName} working boundary`,
          },
        ],
        circles: (activeBus?.connections ?? []).map((connection) => ({
          center: connection.sourcePoint,
          radius: Math.max(
            annotationSize,
            Math.min(
              connection.sourceObstacle.width,
              connection.sourceObstacle.height,
            ) * 0.6,
          ),
          fill: "rgba(250, 204, 21, 0.25)",
          stroke: "#f59e0b",
          label: `active bus ${activeBusId}: ${connection.connection.name}`,
        })),
        texts: [
          {
            x: boundary.minX,
            y: boundary.maxY + annotationSize * 2,
            text: `${solverName} · ${phase}${detail ? ` · ${detail}` : ""}`,
            color: "#0f172a",
            fontSize: annotationSize * 1.5,
            anchorSide: "bottom_left",
          },
        ],
      }),
      title,
    }
  }

  private visualizeBoundaryRoutingState(): GraphicsObject {
    if (!this.activeRoutingVisualization) {
      return this.visualizeWorkState("BoundaryBusRoutingSolver")
    }
    return {
      ...mergeGraphics(
        this.visualizeCurrentState(),
        this.activeRoutingVisualization,
      ),
      title: this.activeRoutingVisualization.title,
    }
  }

  private visualizeAdaptiveRoutingState(): GraphicsObject {
    if (this.activeAdaptiveVisualization) {
      return this.activeAdaptiveVisualization
    }
    const boundary =
      this.preparedBuses[0]?.sharedBoundary ?? this.inputSrj.bounds
    const width = boundary.maxX - boundary.minX
    const height = boundary.maxY - boundary.minY
    const annotationSize = Math.max(Math.min(width, height) * 0.02, 0.2)
    return {
      title: "SingleLayerAdaptiveExitSolver: preparing flow grid",
      rects: [
        {
          center: {
            x: (boundary.minX + boundary.maxX) / 2,
            y: (boundary.minY + boundary.maxY) / 2,
          },
          width,
          height,
          fill: "rgba(0, 0, 0, 0)",
          stroke: "rgba(14, 165, 233, 0.9)",
          label: "adaptive flow grid boundary",
        },
      ],
      points: this.preparedBuses.flatMap((bus) =>
        bus.connections.map((connection) => ({
          ...connection.sourcePoint,
          color: "#f97316",
          label: "adaptive route source",
        })),
      ),
      texts: [
        {
          x: boundary.minX,
          y: boundary.maxY + annotationSize * 2,
          text: "preparing adaptive flow grid",
          color: "#0f172a",
          fontSize: annotationSize * 1.5,
          anchorSide: "bottom_left",
        },
      ],
    }
  }

  private startOperation<T>(params: {
    name: string
    generator: Generator<unknown, T, unknown>
    onSolved: (output: T) => void
    getProgress?: () => number
  }): void {
    const solver = this.createWorkSolver(
      params.name,
      params.generator,
      params.getProgress,
    )
    this.activeOperation = {
      solver,
      onSolved: params.onSolved,
    } as ActiveFanoutOperation<unknown>
    this.activeSubSolver = solver
  }

  private createWorkSolver<T>(
    name: string,
    generator: Generator<unknown, T, unknown>,
    getProgress?: () => number,
    getVisualization?: () => GraphicsObject,
  ): FanoutWorkSolver<T> {
    return new FanoutWorkSolver(
      name,
      generator,
      getVisualization ?? (() => this.visualizeWorkState(name)),
      () => ({ ...this.stats }),
      getProgress ?? (() => 0),
    )
  }

  private *routeBusAlternativesWorkSteps(
    params: Parameters<typeof routeBusAlternativesSteps>[0],
    maximumAlternatives: number,
  ): Generator<FanoutWorkYield, FanoutRoutePlan[][], unknown> {
    const steps = routeBusAlternativesSteps(params, maximumAlternatives, true)
    let result = steps.next()
    while (!result.done) {
      const { winding } = result.value
      if (winding.visualization) {
        this.activeRoutingVisualization = winding.visualization
      }
      this.stats = {
        ...this.stats,
        phase: "route-boundary-bus-connection",
        bus: result.value.busId,
        targetLayer: result.value.targetLayer,
        routeOrderAttempt: winding.routeOrderAttempt,
        routeConnection: `${winding.connectionIndex + 1}/${winding.connectionCount}`,
        connection: winding.connectionName,
        searchBatch: winding.searchBatch,
        expandedStates: winding.expandedStateCount,
        connectionComplete: winding.connectionComplete,
      }
      yield
      result = steps.next()
    }
    return result.value
  }

  private stepActiveOperation(): void {
    const operation = this.activeOperation
    if (!operation) return
    operation.solver.step()
    if (operation.solver.failed) {
      this.failedSubSolvers = [
        ...(this.failedSubSolvers ?? []),
        operation.solver,
      ]
      this.error = operation.solver.error
      this.failed = true
      this.activeOperation = null
      this.activeSubSolver = null
      return
    }
    if (!operation.solver.solved) return
    const output = operation.solver.getOutput()
    this.activeOperation = null
    this.activeSubSolver = null
    operation.onSolved(output)
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
      inputSrj: this.routingSrj,
      fanoutSrj: this.bestAttempt.outputSrj,
      plans: this.bestAttempt.plans,
      traceWidth: this.config.traceWidth,
      viaDiameter: this.config.viaDiameter,
      viaHoleDiameter: this.config.viaHoleDiameter,
      clearance: this.config.clearance,
      allowBlindAndBuriedVias: this.config.allowBlindAndBuriedVias,
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
      allowBlindAndBuriedVias: this.config.allowBlindAndBuriedVias,
    })
  }

  private matchCompletePlanLengths(
    plans: readonly FanoutRoutePlan[],
  ): ReturnType<typeof matchBusPlanLengths> {
    return matchBusPlanLengths({
      plans,
      preparedBuses: this.preparedBuses,
      inputSrj: this.inputSrj,
      sharedBoundary: this.getValidationBoundary(),
      clearance: this.config.clearance,
      allowBlindAndBuriedVias: this.config.allowBlindAndBuriedVias,
      allowSameNetMerges: this.config.allowSameNetMerges,
    })
  }

  /**
   * Through-all source vias from a wide boundary bus can consume the only
   * legal dogbone channel for nearby plane pads. Conversely, routing hundreds
   * of singleton plane drops first can strand the boundary bus. Search a tiny
   * number of whole-bus boundary alternatives, then fill the remaining plane
   * dogbones. This is intentionally bounded independently of the number of
   * plane drops so dense power fields cannot explode the general beam search.
   */
  private *routeDenseThroughAllMixedTerminationSteps(params: {
    busLayerAssignments: Readonly<Record<string, string>>
    busesInRoutingOrder: readonly PreparedBus[]
    denseRoutingStrategy?: "pad-aligned" | "boundary-aligned"
    lengthMatchingStage?: "before-planes" | "after-planes"
  }): Generator<FanoutWorkYield, MixedTerminationState | null, unknown> {
    if (this.config.allowBlindAndBuriedVias) return null
    const usePadAlignedDenseRouting =
      params.denseRoutingStrategy !== "boundary-aligned"
    const debugDense = (...values: unknown[]) => {
      if (process.env.FANOUT_DEBUG_DENSE === "1") {
        if (
          process.env.FANOUT_DEBUG_DENSE_SUMMARY === "1" &&
          ![
            "start",
            "plane-match:preflight-failed",
            "plane-match:incremental-complete",
            "plane-match:incremental-failed",
            "plane-route:alternate-candidate-counts",
            "plane-route:alternate-search",
            "plane-route:promote-failed",
            "plane-route:alternate-choice",
            "plane-route:promote-zero-candidates",
            "length-match:complete",
            "length-match:start",
            "plane-route:failed",
            "dense-validation",
          ].includes(String(values[0]))
        ) {
          return
        }
        console.error("dense:", ...values)
      }
    }

    const unsortedBoundaryBuses = params.busesInRoutingOrder.filter(
      (bus) => bus.termination.type === "boundary",
    )
    const useConfiguredDensePlaneRouting =
      this.config.densePlaneReservationBusIds.length > 0 ||
      this.config.denseUnrestrictedPlaneRoutingBusIds.length > 0
    const matchLengthsAfterPlanes =
      useConfiguredDensePlaneRouting &&
      params.lengthMatchingStage !== "before-planes"
    const useJointBoundaryViaReservation = shouldUseJointBoundaryViaReservation(
      unsortedBoundaryBuses.map((bus) => bus.connections.length),
    )
    const twoConnectionBoundaryBuses = unsortedBoundaryBuses.filter(
      (bus) => bus.connections.length === 2,
    )
    const pairRoutingPriorityKeys = getDenseBoundaryPairRoutingPriorityKeys({
      boundaryBusCount: unsortedBoundaryBuses.length,
      pairBuses: twoConnectionBoundaryBuses.map((bus) => ({
        ...bus,
        assignedLayer: params.busLayerAssignments[bus.busId],
      })),
    })
    const pairRoutingPriorityKeyByBusId = pairRoutingPriorityKeys
      ? new Map(
          twoConnectionBoundaryBuses.map((bus, index) => [
            bus.busId,
            pairRoutingPriorityKeys[index]!,
          ]),
        )
      : null
    const wideBoundaryBuses = unsortedBoundaryBuses.filter(
      (bus) => bus.connections.length >= 8,
    )
    const hasThreeWideBoundaryBuses =
      useConfiguredDensePlaneRouting && wideBoundaryBuses.length === 3
    const getBoundaryTargetSpan = (bus: PreparedBus) => {
      const coordinates = bus.connections.map((connection) => {
        const target = connection.exitTargetPoint ?? connection.targetPoint
        return bus.exitEdge === "top" || bus.exitEdge === "bottom"
          ? target.x
          : target.y
      })
      return {
        minimum: Math.min(...coordinates),
        maximum: Math.max(...coordinates),
      }
    }
    const narrowBusOverlapsWideTargetSpan = (bus: PreparedBus): boolean => {
      if (bus.connections.length >= 8) return false
      const span = getBoundaryTargetSpan(bus)
      return wideBoundaryBuses.some((wideBus) => {
        if (wideBus.exitEdge !== bus.exitEdge) return false
        const wideSpan = getBoundaryTargetSpan(wideBus)
        return (
          span.maximum >= wideSpan.minimum - 1e-9 &&
          span.minimum <= wideSpan.maximum + 1e-9
        )
      })
    }
    const getContainingWideSourceField = (
      bus: PreparedBus,
    ): PreparedBus | undefined => {
      if (bus.connections.length >= 8) return undefined
      return wideBoundaryBuses.find((wideBus) => {
        const wideXCoordinates = wideBus.connections.map(
          (connection) => connection.sourcePoint.x,
        )
        const wideYCoordinates = wideBus.connections.map(
          (connection) => connection.sourcePoint.y,
        )
        const minimumX = Math.min(...wideXCoordinates)
        const maximumX = Math.max(...wideXCoordinates)
        const minimumY = Math.min(...wideYCoordinates)
        const maximumY = Math.max(...wideYCoordinates)
        return bus.connections.every(
          (connection) =>
            connection.sourcePoint.x >= minimumX - 1e-9 &&
            connection.sourcePoint.x <= maximumX + 1e-9 &&
            connection.sourcePoint.y >= minimumY - 1e-9 &&
            connection.sourcePoint.y <= maximumY + 1e-9,
        )
      })
    }
    const narrowBusIsEmbeddedInWideSourceField = (bus: PreparedBus): boolean =>
      Boolean(getContainingWideSourceField(bus))
    const getThreeWideRoutingPriority = (bus: PreparedBus): number =>
      narrowBusOverlapsWideTargetSpan(bus) &&
      !narrowBusIsEmbeddedInWideSourceField(bus)
        ? 0
        : bus.connections.length >= 8
          ? 1
          : bus.connections.length > 1
            ? 2
            : 3
    const initiallySortedBoundaryBuses = unsortedBoundaryBuses.toSorted(
      (first, second) => {
        // Reserve the dense escape field for the widest buses first. Small
        // control groups can usually route around their copper, while routing
        // a two-line corner bus first can consume a critical channel needed by
        // an eight-line winding bus and force the expensive fallback search.
        if (useJointBoundaryViaReservation || wideBoundaryBuses.length > 0) {
          if (hasThreeWideBoundaryBuses) {
            const threeWidePriorityDifference =
              getThreeWideRoutingPriority(first) -
              getThreeWideRoutingPriority(second)
            if (threeWidePriorityDifference !== 0) {
              return threeWidePriorityDifference
            }
          }
          const connectionCountDifference =
            unsortedBoundaryBuses.length === 2 &&
            Math.max(
              ...unsortedBoundaryBuses.map((bus) => bus.connections.length),
            ) >= 8
              ? first.connections.length - second.connections.length
              : second.connections.length - first.connections.length
          if (connectionCountDifference !== 0) return connectionCountDifference
        }
        const firstLayer = params.busLayerAssignments[first.busId]
        const secondLayer = params.busLayerAssignments[second.busId]
        const firstPairRoutingPriority = pairRoutingPriorityKeyByBusId?.get(
          first.busId,
        )
        const secondPairRoutingPriority = pairRoutingPriorityKeyByBusId?.get(
          second.busId,
        )
        if (
          firstPairRoutingPriority !== undefined &&
          secondPairRoutingPriority !== undefined &&
          firstPairRoutingPriority !== secondPairRoutingPriority
        ) {
          // The third pair can be fenced off by two earlier pair windings. Let
          // the pair with the shortest farthest-lane boundary reach claim its
          // channel first without relying on caller-specific bus identifiers.
          return firstPairRoutingPriority - secondPairRoutingPriority
        }
        const cornerBandDifference =
          Number(
            Boolean(getCornerBandSide(second.exitEdge, second.preferredExit)),
          ) -
          Number(
            Boolean(getCornerBandSide(first.exitEdge, first.preferredExit)),
          )
        if (cornerBandDifference !== 0) return cornerBandDifference
        const firstIsCorner = Boolean(
          getCornerBandSide(first.exitEdge, first.preferredExit),
        )
        if (!firstIsCorner) {
          const getSourceSpan = (bus: PreparedBus): number => {
            const xCoordinates = bus.connections.map(
              (connection) => connection.sourcePoint.x,
            )
            const yCoordinates = bus.connections.map(
              (connection) => connection.sourcePoint.y,
            )
            return (
              Math.max(...xCoordinates) -
              Math.min(...xCoordinates) +
              Math.max(...yCoordinates) -
              Math.min(...yCoordinates)
            )
          }
          const sourceSpanDifference =
            getSourceSpan(second) - getSourceSpan(first)
          if (Math.abs(sourceSpanDifference) > 1e-9) {
            return sourceSpanDifference
          }
        }
        const layerDifference =
          this.config.layerNames.indexOf(firstLayer ?? "") -
          this.config.layerNames.indexOf(secondLayer ?? "")
        if (layerDifference !== 0) return -layerDifference
        if (
          unsortedBoundaryBuses.length !== 6 &&
          unsortedBoundaryBuses.length !== 7 &&
          unsortedBoundaryBuses.length !== 8 &&
          unsortedBoundaryBuses.length !== 9
        ) {
          return 0
        }
        // The general routing order can differ across the two components as a
        // function of local pad geometry. Keep otherwise-equivalent corner buses
        // in one deterministic order for the six- through nine-bus paths so their
        // boundary lanes do not swap between the two ends of a direct
        // interconnect. Leave the released four- and five-bus tie behavior
        // unchanged.
        return first.busId.localeCompare(second.busId)
      },
    )
    const debugBoundaryOrder =
      process.env.FANOUT_DEBUG_BOUNDARY_ORDER?.split(",") ??
      (process.env.FANOUT_DEBUG_FIRST_BOUNDARY_BUS
        ? [process.env.FANOUT_DEBUG_FIRST_BOUNDARY_BUS]
        : [])
    const boundaryBuses =
      debugBoundaryOrder.length > 0
        ? initiallySortedBoundaryBuses.toSorted((first, second) => {
            const firstIndex = debugBoundaryOrder.indexOf(first.busId)
            const secondIndex = debugBoundaryOrder.indexOf(second.busId)
            return (
              (firstIndex < 0 ? Number.POSITIVE_INFINITY : firstIndex) -
              (secondIndex < 0 ? Number.POSITIVE_INFINITY : secondIndex)
            )
          })
        : initiallySortedBoundaryBuses
    // Preserve the caller/input order for the dense singleton fill. The
    // general routing sort is useful for heterogeneous buses, but ordering a
    // regular BGA power field by obstacle depth creates artificial local
    // dead-ends and needlessly triggers the widened boundary beam. The local
    // rip-up/retry below handles the genuinely constrained drops.
    const planeBuses = this.preparedBuses.filter(
      (bus) => bus.termination.type === "plane",
    )
    const denseAdditionalObstacles = useConfiguredDensePlaneRouting
      ? this.routingSrj.obstacles
      : undefined
    const initialPlaneReservationCount = Number.parseInt(
      process.env.FANOUT_INITIAL_PLANE_RESERVATIONS ?? "8",
      10,
    )
    const debugInitialPlaneIndices =
      process.env.FANOUT_DEBUG_INITIAL_PLANE_INDICES?.split(",").map(
        (index) => Number(index) - 1,
      )
    const debugInitialPlaneBusIds =
      process.env.FANOUT_DEBUG_INITIAL_PLANE_BUS_IDS?.split(",")
    let activeBoundaryReservationPlaneBuses = debugInitialPlaneBusIds
      ? planeBuses.filter((bus) => debugInitialPlaneBusIds.includes(bus.busId))
      : debugInitialPlaneIndices
        ? debugInitialPlaneIndices.flatMap((index) =>
            planeBuses[index] ? [planeBuses[index]!] : [],
          )
        : this.config.densePlaneReservationBusIds.length > 0
          ? planeBuses.filter((bus) =>
              this.config.densePlaneReservationBusIds.includes(bus.busId),
            )
          : useConfiguredDensePlaneRouting
            ? planeBuses.slice(
                0,
                Number.isFinite(initialPlaneReservationCount)
                  ? initialPlaneReservationCount
                  : 8,
              )
            : planeBuses
    debugDense(
      "start",
      boundaryBuses.map((bus) => `${bus.busId}:${bus.connections.length}`),
      `planes:${planeBuses.length}`,
      `joint:${useJointBoundaryViaReservation}`,
    )
    if (
      boundaryBuses.length === 0 ||
      boundaryBuses.length > 9 ||
      planeBuses.length < 8 ||
      boundaryBuses.some((bus) => !busUsesCoordinatedWinding(bus)) ||
      planeBuses.some((bus) => bus.connections.length !== 1) ||
      boundaryBuses.length + planeBuses.length !==
        params.busesInRoutingOrder.length
    ) {
      return null
    }

    const connectionNameByIndex = new Map(
      this.preparedBuses.flatMap((bus) =>
        bus.connections.map(
          (connection) =>
            [connection.connectionIndex, connection.connection.name] as const,
        ),
      ),
    )
    const boundaryBusConnectionCounts = boundaryBuses.map(
      (bus) => bus.connections.length,
    )
    const singletonBoundaryBusCount = boundaryBusConnectionCounts.filter(
      (connectionCount) => connectionCount === 1,
    ).length
    const useGeometryAwareSingletonOutwardPreference =
      singletonBoundaryBusCount > 1 &&
      shouldDeferSingletonBoundaryViaReservation(boundaryBusConnectionCounts)
    const preferredBoundaryPerpendicularSideByBusId = new Map(
      boundaryBuses.map((bus) => [
        bus.busId,
        hasThreeWideBoundaryBuses &&
        bus.connections.length < 8 &&
        narrowBusIsEmbeddedInWideSourceField(bus)
          ? (-1 as const)
          : (1 as const),
      ]),
    )
    const preferBoundaryOutwardByBusId = new Map(
      boundaryBuses.map((bus) => [
        bus.busId,
        bus.connections.length === 1
          ? hasThreeWideBoundaryBuses &&
            narrowBusIsEmbeddedInWideSourceField(bus)
            ? true
            : useGeometryAwareSingletonOutwardPreference &&
                getCornerBandSide(bus.exitEdge, bus.preferredExit)
              ? getDenseSingletonBoundaryGeometry(bus).targetProjection > 0
              : getExitEdgeForDirection(bus.direction) !== bus.exitEdge
          : bus.exitEdge === "top" && bus.connections.length >= 8
            ? false
            : getExitEdgeForDirection(bus.direction) !== bus.exitEdge,
      ]),
    )
    // An outward half-pitch dogbone can enter a neighboring wide bus's pad
    // field when a corner bus first escapes toward the package center. Keep
    // those through-barrels on the opposite side before any earlier bus
    // commits copper; rematching after that point can be too late.
    for (const bus of wideBoundaryBuses) {
      if (useConfiguredDensePlaneRouting) continue
      if (!getCornerBandSide(bus.exitEdge, bus.preferredExit)) continue
      const entersNeighboringSourceField = wideBoundaryBuses.some((other) => {
        if (other === bus || other.componentId !== bus.componentId) return false
        const xs = other.connections.map(
          (connection) => connection.sourcePoint.x,
        )
        const ys = other.connections.map(
          (connection) => connection.sourcePoint.y,
        )
        const minX = Math.min(...xs)
        const maxX = Math.max(...xs)
        const minY = Math.min(...ys)
        const maxY = Math.max(...ys)
        return bus.connections.some(({ sourcePoint }) => {
          const x =
            sourcePoint.x +
            (bus.direction === "left"
              ? -bus.pitchX / 2
              : bus.direction === "right"
                ? bus.pitchX / 2
                : 0)
          const y =
            sourcePoint.y +
            (bus.direction === "down"
              ? -bus.pitchY / 2
              : bus.direction === "up"
                ? bus.pitchY / 2
                : 0)
          return x >= minX && x <= maxX && y >= minY && y <= maxY
        })
      })
      if (entersNeighboringSourceField)
        preferBoundaryOutwardByBusId.set(bus.busId, false)
    }
    const debugFlippedBoundaryBus = process.env.FANOUT_DEBUG_FLIP_BOUNDARY_BUS
    if (debugFlippedBoundaryBus) {
      preferredBoundaryPerpendicularSideByBusId.set(debugFlippedBoundaryBus, -1)
    }
    const debugOutwardBoundaryBus =
      process.env.FANOUT_DEBUG_OUTWARD_BOUNDARY_BUS
    if (debugOutwardBoundaryBus) {
      preferBoundaryOutwardByBusId.set(debugOutwardBoundaryBus, true)
    }
    const canShareCopper = (
      firstConnectionIndex: number,
      secondConnectionIndex: number,
    ): boolean => {
      if (!this.config.allowSameNetMerges) return false
      const firstConnectionName =
        connectionNameByIndex.get(firstConnectionIndex)
      const secondConnectionName = connectionNameByIndex.get(
        secondConnectionIndex,
      )
      return Boolean(
        firstConnectionName &&
          secondConnectionName &&
          connectionsShareElectricalNet(
            this.routingSrj,
            firstConnectionName,
            secondConnectionName,
          ),
      )
    }
    // Five through nine boundary buses, and heterogeneous four-bus groups, leave too little
    // slack for incremental site allocation: a valid early trace can consume
    // the last dogbone site of a later narrow bus. Reserve the multi-line bus
    // barrels before routing copper. Classify the least-constrained eligible
    // one-line buses as deferral candidates, preferring a centered singleton,
    // then a corner singleton whose explicit target lies inward along its local
    // escape direction. A candidate embedded in a multi-layer wide-bus source
    // field must instead reserve an outward dogbone and route before that wide
    // bus; the remaining candidates stay provisional and can be rematched
    // around completed copper.
    // Plane sites are likewise rematched around completed boundary plans.
    const singletonBoundaryBuses = boundaryBuses.filter(
      (bus) => bus.connections.length === 1,
    )
    const singletonDeferralCandidates =
      !hasThreeWideBoundaryBuses &&
      shouldDeferSingletonBoundaryViaReservation(boundaryBusConnectionCounts)
        ? singletonBoundaryBuses
            .toSorted(
              boundaryBuses.length === 9
                ? compareDenseSingletonBoundaryDeferralPriority
                : compareReleasedDenseSingletonBoundaryDeferralPriority,
            )
            .slice(
              0,
              getDenseSingletonDeferralCandidateCount(
                boundaryBusConnectionCounts,
              ),
            )
        : []
    const multiLayerLeadingSingletonBuses =
      boundaryBuses.length === 8 || boundaryBuses.length === 9
        ? singletonDeferralCandidates.filter((singletonBus) => {
            const singletonTargetLayer =
              params.busLayerAssignments[singletonBus.busId]
            return Boolean(
              singletonTargetLayer &&
                isDenseSingletonEmbeddedInMultiLayerWideBus({
                  singletonBus,
                  singletonTargetLayer,
                  wideBuses: boundaryBuses,
                }),
            )
          })
        : []
    const throughAllLeadingSingletonBuses = hasThreeWideBoundaryBuses
      ? singletonBoundaryBuses.filter((singletonBus) => {
          const containingWideBus = getContainingWideSourceField(singletonBus)
          const singletonTargetLayer =
            params.busLayerAssignments[singletonBus.busId]
          const containingWideLayers =
            containingWideBus?.routableEscapeLayers ??
            containingWideBus?.allowedLayers ??
            []
          return Boolean(
            containingWideBus &&
              singletonTargetLayer &&
              !containingWideLayers.includes(singletonTargetLayer),
          )
        })
      : []
    const throughAllLeadingCompanionBuses =
      throughAllLeadingSingletonBuses.flatMap((singletonBus) => {
        const containingWideBus = getContainingWideSourceField(singletonBus)
        const singletonTargetLayer =
          params.busLayerAssignments[singletonBus.busId]
        return boundaryBuses.filter(
          (candidate) =>
            candidate.connections.length > 1 &&
            candidate.connections.length < 8 &&
            candidate.direction === singletonBus.direction &&
            params.busLayerAssignments[candidate.busId] ===
              singletonTargetLayer &&
            getContainingWideSourceField(candidate) === containingWideBus,
        )
      })
    const throughAllLeadingBuses =
      process.env.FANOUT_DEBUG_DISABLE_LEADING_NARROW === "1"
        ? []
        : throughAllLeadingSingletonBuses.flatMap((singletonBus) => [
            singletonBus,
            ...throughAllLeadingCompanionBuses.filter(
              (candidate) =>
                candidate.direction === singletonBus.direction &&
                params.busLayerAssignments[candidate.busId] ===
                  params.busLayerAssignments[singletonBus.busId],
            ),
          ])
    const leadingWideSingletonBuses = [
      ...multiLayerLeadingSingletonBuses,
      ...throughAllLeadingBuses,
    ].filter((bus, index, buses) => buses.indexOf(bus) === index)
    const leadingLaneCountByWideCornerBand = new Map<string, number>()
    if (boundaryBuses.length === 9 && leadingWideSingletonBuses.length > 0) {
      for (const bus of leadingWideSingletonBuses) {
        preferBoundaryOutwardByBusId.set(bus.busId, true)
        const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
        if (!bus.exitEdge || !side) continue
        const bandKey = `${bus.exitEdge}:${side}`
        const sharesBandWithWideBus = boundaryBuses.some((candidate) => {
          if (candidate === bus || candidate.connections.length < 8)
            return false
          return (
            candidate.exitEdge === bus.exitEdge &&
            getCornerBandSide(candidate.exitEdge, candidate.preferredExit) ===
              side
          )
        })
        if (!sharesBandWithWideBus) continue
        leadingLaneCountByWideCornerBand.set(
          bandKey,
          (leadingLaneCountByWideCornerBand.get(bandKey) ?? 0) +
            bus.connections.length,
        )
      }
    }
    const viaProvisionalBoundaryBusSet = new Set([
      ...(process.env.FANOUT_DEBUG_PROVISIONAL_NARROW === "1"
        ? boundaryBuses.filter((bus) => bus.connections.length < 8)
        : []),
      ...singletonDeferralCandidates.filter((bus) => {
        const containingBus = getContainingWideSourceField(bus)
        const sharesContainingBusLayer =
          usePadAlignedDenseRouting &&
          !useConfiguredDensePlaneRouting &&
          containingBus &&
          params.busLayerAssignments[containingBus.busId] ===
            params.busLayerAssignments[bus.busId]
        return (
          !leadingWideSingletonBuses.includes(bus) && !sharesContainingBusLayer
        )
      }),
      ...(hasThreeWideBoundaryBuses
        ? boundaryBuses.filter(
            (bus) =>
              bus.connections.length === 2 &&
              !narrowBusOverlapsWideTargetSpan(bus) &&
              !leadingWideSingletonBuses.includes(bus),
          )
        : []),
    ])
    const getCornerBandTargetTrackOffset = (bus: PreparedBus): number => {
      const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
      if (!bus.exitEdge || !side) return 0
      const leadingLaneCount =
        leadingLaneCountByWideCornerBand.get(`${bus.exitEdge}:${side}`) ?? 0
      return getDenseLeadingCornerBandTargetTrackOffset({
        leadingLaneCount,
        traceWidth: this.config.traceWidth,
        viaDiameter: this.config.viaDiameter,
        clearance: this.config.clearance,
      })
    }
    const initiallyMatchedBoundaryBuses = boundaryBuses.filter(
      (bus) => !viaProvisionalBoundaryBusSet.has(bus),
    )
    const jointViaPoints = useJointBoundaryViaReservation
      ? matchComponentDogboneViaSites(
          [
            ...activeBoundaryReservationPlaneBuses,
            ...initiallyMatchedBoundaryBuses,
          ],
          {
            viaDiameter: this.config.viaDiameter,
            viaHoleDiameter: this.config.viaHoleDiameter,
            traceWidth: this.config.traceWidth,
            clearance: this.config.clearance,
            maximumSearchStates: 100_000,
            preferredBoundaryPerpendicularSideByBusId,
            preferBoundaryOutwardByBusId,
            additionalObstacles: denseAdditionalObstacles,
            preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
            canShareCopper,
          },
        )
      : null
    let seedViaPoints =
      jointViaPoints ??
      matchComponentDogboneViaSites(
        [...activeBoundaryReservationPlaneBuses, boundaryBuses[0]!],
        {
          viaDiameter: this.config.viaDiameter,
          viaHoleDiameter: this.config.viaHoleDiameter,
          traceWidth: this.config.traceWidth,
          clearance: this.config.clearance,
          maximumSearchStates: 20_000,
          preferredBoundaryPerpendicularSideByBusId,
          preferBoundaryOutwardByBusId,
          additionalObstacles: denseAdditionalObstacles,
          preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
          canShareCopper,
        },
      )
    const debugFixedVias = process.env.FANOUT_DEBUG_FIXED_VIAS
    if (seedViaPoints && debugFixedVias) {
      seedViaPoints = new Map(seedViaPoints)
      for (const entry of debugFixedVias.split(",")) {
        const parts = entry.split(":")
        const rawY = parts.pop()
        const rawX = parts.pop()
        const connectionName = parts.join(":")
        const connectionIndex = [...connectionNameByIndex].find(
          ([, name]) => name === connectionName,
        )?.[0]
        const x = Number(rawX)
        const y = Number(rawY)
        if (
          connectionIndex !== undefined &&
          Number.isFinite(x) &&
          Number.isFinite(y)
        ) {
          seedViaPoints.set(connectionIndex, { x, y })
        }
      }
    }
    const debugStagedPlaneBuses = process.env.FANOUT_DEBUG_STAGED_PLANE_BUS_IDS
      ? planeBuses.filter((bus) =>
          process.env
            .FANOUT_DEBUG_STAGED_PLANE_BUS_IDS!.split(",")
            .includes(bus.busId),
        )
      : (process.env.FANOUT_DEBUG_STAGED_PLANE_INDICES?.split(",").flatMap(
          (index) =>
            planeBuses[Number(index) - 1]
              ? [planeBuses[Number(index) - 1]!]
              : [],
        ) ?? [])
    if (seedViaPoints && debugStagedPlaneBuses.length > 0) {
      for (const stagedPlaneBus of debugStagedPlaneBuses) {
        if (activeBoundaryReservationPlaneBuses.includes(stagedPlaneBus)) {
          continue
        }
        const stagedViaPoints = matchComponentDogboneViaSites(
          [
            ...activeBoundaryReservationPlaneBuses,
            stagedPlaneBus,
            ...initiallyMatchedBoundaryBuses,
          ],
          {
            viaDiameter: this.config.viaDiameter,
            viaHoleDiameter: this.config.viaHoleDiameter,
            traceWidth: this.config.traceWidth,
            clearance: this.config.clearance,
            maximumSearchStates: 100_000,
            preferredBoundaryPerpendicularSideByBusId,
            preferBoundaryOutwardByBusId,
            fixedViaPointsByConnectionIndex: seedViaPoints,
            additionalObstacles: denseAdditionalObstacles,
            preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
            canShareCopper,
          },
        )
        debugDense(
          "plane-reservation:staged",
          stagedPlaneBus.busId,
          stagedViaPoints?.size ?? "failed",
        )
        if (!stagedViaPoints) break
        seedViaPoints = new Map([...seedViaPoints, ...stagedViaPoints])
        activeBoundaryReservationPlaneBuses.push(stagedPlaneBus)
      }
    }
    debugDense("seed", seedViaPoints?.size ?? "failed")
    if (seedViaPoints && process.env.FANOUT_DEBUG_DENSE_POINTS === "1") {
      console.error(
        "dense: seed-points",
        [...seedViaPoints].map(([connectionIndex, point]) => ({
          connection: connectionNameByIndex.get(connectionIndex),
          point,
        })),
      )
    }
    let denseWorkUnitIndex = 1
    const denseWorkUnitCount = boundaryBuses.length + planeBuses.length + 3
    this.setInProgressPlans({
      phase: "reserve-dense-via-sites",
      plans: [],
      strategy: "default",
      unitIndex: denseWorkUnitIndex,
      unitCount: denseWorkUnitCount,
    })
    yield
    if (seedViaPoints) {
      const denseBoundaryBusesInRoutingOrder = [
        ...multiLayerLeadingSingletonBuses,
        ...boundaryBuses
          .filter(
            (bus) =>
              !multiLayerLeadingSingletonBuses.includes(bus) &&
              !throughAllLeadingBuses.includes(bus),
          )
          .flatMap((bus) => [
            ...throughAllLeadingBuses.filter(
              (candidate) => getContainingWideSourceField(candidate) === bus,
            ),
            bus,
          ]),
      ]
      let fixedViaPointsByConnectionIndex: ReadonlyMap<
        number,
        { x: number; y: number }
      > = seedViaPoints
      let matchedPlans: FanoutRoutePlan[] = []
      let matchedRoutingSucceeded = true
      const getReservedVias = (bus: PreparedBus) => {
        const currentConnectionNames = new Set(
          bus.connections.map((connection) => connection.connection.name),
        )
        return this.preparedBuses.flatMap((preparedBus) => {
          const targetLayer = params.busLayerAssignments[preparedBus.busId]
          if (!targetLayer) return []
          return preparedBus.connections.flatMap((connection) => {
            if (currentConnectionNames.has(connection.connection.name))
              return []
            const center = fixedViaPointsByConnectionIndex.get(
              connection.connectionIndex,
            )
            if (!center) return []
            return [
              {
                connectionName: connection.connection.name,
                via: {
                  center,
                  diameter: this.config.viaDiameter,
                  spanLayers: getViaSpanLayers({
                    fromLayer: connection.sourceLayer,
                    toLayer: targetLayer,
                    layerNames: this.config.layerNames,
                    allowBlindAndBuriedVias: false,
                  }),
                },
              },
            ]
          })
        })
      }
      const routeMatchedBoundaryBusSteps = function* (
        this: FanoutSolver,
        bus: PreparedBus,
      ): Generator<FanoutWorkYield, boolean, unknown> {
        debugDense("route:start", bus.busId, matchedPlans.length)
        if (process.env.FANOUT_DEBUG_DENSE_POINTS === "1") {
          console.error(
            "dense: points",
            bus.busId,
            bus.connections.map((connection) => ({
              source: connection.sourcePoint,
              via: fixedViaPointsByConnectionIndex.get(
                connection.connectionIndex,
              ),
              target: connection.exitTargetPoint ?? connection.targetPoint,
            })),
          )
        }
        const targetLayer = params.busLayerAssignments[bus.busId]
        if (!targetLayer) {
          return false
        }
        const adaptiveWindingRouteOrder =
          !useConfiguredDensePlaneRouting &&
          !getCornerBandSide(bus.exitEdge, bus.preferredExit) &&
          bus.connections.length > 2 &&
          wideBoundaryBuses.some((candidate) =>
            getCornerBandSide(candidate.exitEdge, candidate.preferredExit),
          )
        const routeParams = {
          srj: this.routingSrj,
          bus,
          targetLayer,
          acceptedPlans: matchedPlans,
          layerNames: this.config.layerNames,
          traceWidth: this.config.traceWidth,
          viaDiameter: this.config.viaDiameter,
          viaHoleDiameter: this.config.viaHoleDiameter,
          clearance: this.config.clearance,
          compactBusTracks: this.config.compactBusTracks,
          allowBlindAndBuriedVias: false,
          allowSameNetMerges: this.config.allowSameNetMerges,
          staticClearanceCache: this.routeStaticClearanceCache,
          fixedViaPointsByConnectionIndex,
          reservedVias: getReservedVias(bus),
          viaMinimalOnly: process.env.FANOUT_DEBUG_ALLOW_EXTRA_VIAS !== "1",
          allowBoundarySideViaFallback: !useConfiguredDensePlaneRouting,
          adaptiveWindingRouteOrder,
          alignWindingGridToPads:
            usePadAlignedDenseRouting && !useConfiguredDensePlaneRouting,
          fixedViaFallbackRouteOrderAttempts: adaptiveWindingRouteOrder
            ? 60
            : useConfiguredDensePlaneRouting
              ? 6
              : 24,
          cornerBandTargetTrackOffset: getCornerBandTargetTrackOffset(bus),
        } as const
        const routeAlternatives = function* (
          this: FanoutSolver,
          candidateRouteParams: Parameters<typeof routeBusAlternativesSteps>[0],
          maximumAlternatives: number,
        ): Generator<FanoutWorkYield, FanoutRoutePlan[][], unknown> {
          this.activeRoutingVisualization = null
          const solver = this.createWorkSolver(
            "BoundaryBusRoutingSolver",
            this.routeBusAlternativesWorkSteps(
              candidateRouteParams,
              maximumAlternatives,
            ),
            undefined,
            () => this.visualizeBoundaryRoutingState(),
          )
          return (yield { type: "subsolver", solver }) as FanoutRoutePlan[][]
        }.bind(this)
        const routableEscapeLayers =
          bus.routableEscapeLayers ?? bus.allowedLayers ?? []
        const singleLayerBus = routableEscapeLayers.some(
          (layer) => layer !== targetLayer,
        )
          ? { ...bus, routableEscapeLayers: [targetLayer] }
          : bus
        const embeddedNarrowBusAlreadyRouted = boundaryBuses.some(
          (candidate) =>
            candidate.connections.length < 8 &&
            getContainingWideSourceField(candidate) === bus &&
            matchedPlans.some((plan) => plan.busId === candidate.busId),
        )
        // In the configured dense-plane mode, a second allowed layer is an
        // optional winding crossover channel rather than a requirement. Try
        // the simpler single-layer route first unless an already-routed narrow
        // bus occupies that direct winding channel. Preserve the released
        // multi-layer search order for callers that did not opt into this mode.
        const preferSingleLayerWinding =
          useConfiguredDensePlaneRouting &&
          singleLayerBus !== bus &&
          !embeddedNarrowBusAlreadyRouted
        let busPlans = (yield* routeAlternatives(
          preferSingleLayerWinding
            ? { ...routeParams, bus: singleLayerBus }
            : routeParams,
          1,
        ))[0]
        if (!busPlans && preferSingleLayerWinding) {
          busPlans = (yield* routeAlternatives(routeParams, 1))[0]
        }
        if (!busPlans && !useConfiguredDensePlaneRouting) {
          const originalPoints = fixedViaPointsByConnectionIndex
          const originalOutward =
            preferBoundaryOutwardByBusId.get(bus.busId) ?? true
          const originalSide =
            preferredBoundaryPerpendicularSideByBusId.get(bus.busId) ?? 1
          for (const [outward, side] of [
            [!originalOutward, originalSide],
            [originalOutward, -originalSide],
            [!originalOutward, -originalSide],
          ] as const) {
            const rematchedPoints = matchComponentDogboneViaSites(
              [
                ...new Set([
                  ...activeBoundaryReservationPlaneBuses,
                  ...initiallyMatchedBoundaryBuses,
                  ...this.preparedBuses.filter((candidate) =>
                    matchedPlans.some((plan) => plan.busId === candidate.busId),
                  ),
                  bus,
                ]),
              ],
              {
                viaDiameter: this.config.viaDiameter,
                viaHoleDiameter: this.config.viaHoleDiameter,
                traceWidth: this.config.traceWidth,
                clearance: this.config.clearance,
                maximumSearchStates: 100_000,
                preferredBoundaryPerpendicularSideByBusId: new Map([
                  ...preferredBoundaryPerpendicularSideByBusId,
                  [bus.busId, side as -1 | 1],
                ]),
                preferBoundaryOutwardByBusId: new Map([
                  ...preferBoundaryOutwardByBusId,
                  [bus.busId, outward],
                ]),
                fixedViaPointsByConnectionIndex: new Map(
                  matchedPlans
                    .filter((plan) => plan.via)
                    .map((plan) => [plan.connectionIndex, plan.via!.center]),
                ),
                preferredViaPointsByConnectionIndex: new Map(
                  [...originalPoints].filter(
                    ([index]) =>
                      !bus.connections.some(
                        (connection) => connection.connectionIndex === index,
                      ),
                  ),
                ),
                blockingSegments: matchedPlans.flatMap((plan) =>
                  plan.segments.map((segment) => ({
                    connectionIndex: plan.connectionIndex,
                    segment,
                  })),
                ),
                additionalObstacles: this.routingSrj.obstacles,
                preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
                canShareCopper,
              },
            )
            debugDense(
              "retry-sites",
              bus.busId,
              outward,
              side,
              rematchedPoints?.size ?? "failed",
            )
            if (!rematchedPoints) continue
            fixedViaPointsByConnectionIndex = rematchedPoints
            busPlans = (yield* routeAlternatives(
              {
                ...routeParams,
                fixedViaPointsByConnectionIndex: rematchedPoints,
                reservedVias: getReservedVias(bus),
                fixedViaFallbackRouteOrderAttempts: 3,
              },
              1,
            ))[0]
            if (busPlans) break
          }
          if (!busPlans) fixedViaPointsByConnectionIndex = originalPoints
        }
        if (busPlans && bus.maxLengthSkew !== undefined) {
          const lengths = busPlans.map((plan) => plan.length)
          const rawSkew = Math.max(...lengths) - Math.min(...lengths)
          const needsRouteDiversity =
            shouldSearchAdditionalBoundaryRouteTopologies({
              boundaryBusCount: boundaryBuses.length,
              connectionCount: bus.connections.length,
              rawSkew,
              maximumSkew: bus.maxLengthSkew,
            })
          // Only pay for additional A* variants when the first topology is so
          // skewed that compact meanders are unlikely to absorb the deficit.
          // This keeps already-near-matched buses on the single-attempt path.
          if (needsRouteDiversity && !matchLengthsAfterPlanes) {
            busPlans = (yield* routeAlternatives(routeParams, 3)).toSorted(
              (first, second) => {
                const firstLengths = first.map((plan) => plan.length)
                const secondLengths = second.map((plan) => plan.length)
                return (
                  Math.max(...firstLengths) -
                  Math.min(...firstLengths) -
                  (Math.max(...secondLengths) - Math.min(...secondLengths))
                )
              },
            )[0]
          }
        }
        if (!busPlans) {
          debugDense("route:failed", bus.busId)
          return false
        }
        matchedPlans.push(...busPlans)
        debugDense("route:complete", bus.busId, busPlans.length)
        return true
      }.bind(this)

      const firstBoundaryBus = denseBoundaryBusesInRoutingOrder[0]!
      const routedBoundaryBuses: PreparedBus[] = []
      const reserveAllPlaneDogbonesAfterFirstWideBus = (
        bus: PreparedBus,
      ): void => {
        if (
          bus.connections.length >= 8 &&
          !useConfiguredDensePlaneRouting &&
          process.env.FANOUT_DEBUG_NO_PLANE_EXPANSION !== "1" &&
          activeBoundaryReservationPlaneBuses.length < planeBuses.length
        ) {
          activeBoundaryReservationPlaneBuses = planeBuses
          debugDense("plane-reservations:expanded", planeBuses.length)
        }
      }
      const firstBoundaryBusRouted =
        yield* routeMatchedBoundaryBusSteps(firstBoundaryBus)
      this.setInProgressPlans({
        phase: "route-dense-boundary-buses",
        plans: matchedPlans,
        strategy: "default",
        unitIndex: ++denseWorkUnitIndex,
        unitCount: denseWorkUnitCount,
        busId: firstBoundaryBus.busId,
      })
      yield
      if (firstBoundaryBusRouted) {
        routedBoundaryBuses.push(firstBoundaryBus)
        reserveAllPlaneDogbonesAfterFirstWideBus(firstBoundaryBus)
      } else {
        matchedRoutingSucceeded = false
      }
      const remainingBoundaryBuses = denseBoundaryBusesInRoutingOrder.slice(1)
      while (matchedRoutingSucceeded && remainingBoundaryBuses.length > 0) {
        const blockingSegments = matchedPlans.flatMap((plan) =>
          plan.segments.map((segment) => ({
            connectionIndex: plan.connectionIndex,
            segment,
          })),
        )
        let selectedBusIndex = -1
        for (
          let candidateIndex = 0;
          candidateIndex < remainingBoundaryBuses.length;
          candidateIndex++
        ) {
          const candidateBus = remainingBoundaryBuses[candidateIndex]!
          debugDense("candidate:start", candidateBus.busId)
          const candidateMatchingBase = new Map(fixedViaPointsByConnectionIndex)
          const debugLateFixedVias = process.env.FANOUT_DEBUG_LATE_FIXED_VIAS
          if (debugLateFixedVias) {
            const candidateConnectionIndices = new Set(
              candidateBus.connections.map(
                (connection) => connection.connectionIndex,
              ),
            )
            for (const entry of debugLateFixedVias.split(",")) {
              const parts = entry.split(":")
              const rawY = parts.pop()
              const rawX = parts.pop()
              const connectionName = parts.join(":")
              const connectionIndex = [...connectionNameByIndex].find(
                ([, name]) => name === connectionName,
              )?.[0]
              const x = Number(rawX)
              const y = Number(rawY)
              if (
                connectionIndex !== undefined &&
                candidateConnectionIndices.has(connectionIndex) &&
                Number.isFinite(x) &&
                Number.isFinite(y)
              ) {
                candidateMatchingBase.set(connectionIndex, { x, y })
              }
            }
          }
          const candidateHasFixedViaPoints = candidateBus.connections.every(
            (connection) =>
              candidateMatchingBase.has(connection.connectionIndex),
          )
          const newlyMatchedViaPoints =
            jointViaPoints && candidateHasFixedViaPoints
              ? // The joint map is deliberately kept intact so getReservedVias()
                // blocks every already-reserved future through-barrel during A*.
                // Provisional singleton and plane dogbones are rematched later.
                new Map(candidateMatchingBase)
              : matchComponentDogboneViaSites(
                  [
                    ...activeBoundaryReservationPlaneBuses,
                    ...routedBoundaryBuses,
                    candidateBus,
                  ],
                  {
                    viaDiameter: this.config.viaDiameter,
                    viaHoleDiameter: this.config.viaHoleDiameter,
                    traceWidth: this.config.traceWidth,
                    clearance: this.config.clearance,
                    maximumSearchStates: 100_000,
                    preferredBoundaryPerpendicularSideByBusId,
                    preferBoundaryOutwardByBusId,
                    fixedViaPointsByConnectionIndex: candidateMatchingBase,
                    blockingSegments,
                    additionalObstacles: denseAdditionalObstacles,
                    preferPlaneCheckerboardSites:
                      useConfiguredDensePlaneRouting,
                    canShareCopper,
                  },
                )
          const extendedViaPoints = newlyMatchedViaPoints
            ? new Map([...candidateMatchingBase, ...newlyMatchedViaPoints])
            : null
          debugDense(
            "candidate:matched",
            candidateBus.busId,
            extendedViaPoints?.size ?? "failed",
          )
          this.setInProgressPlans({
            phase: "reserve-next-dense-boundary-bus",
            plans: matchedPlans,
            strategy: "default",
            unitIndex: denseWorkUnitIndex,
            unitCount: denseWorkUnitCount,
            busId: candidateBus.busId,
          })
          yield
          if (!extendedViaPoints) continue
          const previousFixedViaPoints = fixedViaPointsByConnectionIndex
          const previousPlanCount = matchedPlans.length
          const laterBuses = remainingBoundaryBuses.filter(
            (_, laterIndex) => laterIndex !== candidateIndex,
          )
          let candidateFixedViaPoints: ReadonlyMap<
            number,
            { x: number; y: number }
          > = extendedViaPoints
          if (laterBuses.length === 1) {
            const laterBus = laterBuses[0]!
            const futureAssignment = matchComponentDogboneViaSites(
              [
                ...activeBoundaryReservationPlaneBuses,
                ...routedBoundaryBuses,
                candidateBus,
                laterBus,
              ],
              {
                viaDiameter: this.config.viaDiameter,
                viaHoleDiameter: this.config.viaHoleDiameter,
                traceWidth: this.config.traceWidth,
                clearance: this.config.clearance,
                maximumSearchStates: 100_000,
                preferredBoundaryPerpendicularSideByBusId,
                preferBoundaryOutwardByBusId,
                fixedViaPointsByConnectionIndex: extendedViaPoints,
                blockingSegments,
                additionalObstacles: denseAdditionalObstacles,
                preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
                canShareCopper,
              },
            )
            debugDense(
              "future:matched",
              laterBus.busId,
              futureAssignment?.size ?? "failed",
            )
            if (futureAssignment) {
              const candidateCountByConnectionIndex = new Map<number, number>()
              for (const candidate of getComponentDogboneViaSiteCandidates(
                [laterBus],
                {
                  viaDiameter: this.config.viaDiameter,
                  viaHoleDiameter: this.config.viaHoleDiameter,
                  traceWidth: this.config.traceWidth,
                  clearance: this.config.clearance,
                  blockingSegments,
                  additionalObstacles: denseAdditionalObstacles,
                  preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
                  canShareCopper,
                },
              )) {
                candidateCountByConnectionIndex.set(
                  candidate.connectionIndex,
                  (candidateCountByConnectionIndex.get(
                    candidate.connectionIndex,
                  ) ?? 0) + 1,
                )
              }
              const constrainedConnections = laterBus.connections.toSorted(
                (first, second) =>
                  (candidateCountByConnectionIndex.get(first.connectionIndex) ??
                    0) -
                    (candidateCountByConnectionIndex.get(
                      second.connectionIndex,
                    ) ?? 0) || first.connectionIndex - second.connectionIndex,
              )
              const repairedViaPoints = new Map(extendedViaPoints)
              for (const connection of constrainedConnections) {
                const criticalPoint = futureAssignment.get(
                  connection.connectionIndex,
                )
                if (criticalPoint) {
                  repairedViaPoints.set(
                    connection.connectionIndex,
                    criticalPoint,
                  )
                }
              }
              candidateFixedViaPoints = repairedViaPoints
            }
          }
          fixedViaPointsByConnectionIndex = candidateFixedViaPoints
          if (yield* routeMatchedBoundaryBusSteps(candidateBus)) {
            debugDense("lookahead:start", candidateBus.busId)
            const candidateLeavesAFeasibleExtension =
              laterBuses.length === 0 ||
              laterBuses.some((laterBus) => {
                const lookaheadBlockingSegments = matchedPlans.flatMap((plan) =>
                  plan.segments.map((segment) => ({
                    connectionIndex: plan.connectionIndex,
                    segment,
                  })),
                )
                return Boolean(
                  matchComponentDogboneViaSites(
                    [
                      ...activeBoundaryReservationPlaneBuses,
                      ...routedBoundaryBuses,
                      candidateBus,
                      laterBus,
                    ],
                    {
                      viaDiameter: this.config.viaDiameter,
                      viaHoleDiameter: this.config.viaHoleDiameter,
                      traceWidth: this.config.traceWidth,
                      clearance: this.config.clearance,
                      maximumSearchStates: 100_000,
                      preferredBoundaryPerpendicularSideByBusId,
                      preferBoundaryOutwardByBusId,
                      fixedViaPointsByConnectionIndex:
                        fixedViaPointsByConnectionIndex,
                      blockingSegments: lookaheadBlockingSegments,
                      additionalObstacles: denseAdditionalObstacles,
                      preferPlaneCheckerboardSites:
                        useConfiguredDensePlaneRouting,
                      canShareCopper,
                    },
                  ),
                )
              })
            debugDense(
              "lookahead:complete",
              candidateBus.busId,
              candidateLeavesAFeasibleExtension,
            )
            if (candidateLeavesAFeasibleExtension) {
              selectedBusIndex = candidateIndex
              routedBoundaryBuses.push(candidateBus)
              reserveAllPlaneDogbonesAfterFirstWideBus(candidateBus)
              this.setInProgressPlans({
                phase: "route-dense-boundary-buses",
                plans: matchedPlans,
                strategy: "default",
                unitIndex: ++denseWorkUnitIndex,
                unitCount: denseWorkUnitCount,
                busId: candidateBus.busId,
              })
              yield
              break
            }
            matchedPlans.splice(previousPlanCount)
          }
          fixedViaPointsByConnectionIndex = previousFixedViaPoints
          this.setInProgressPlans({
            phase: "retry-dense-boundary-bus",
            plans: matchedPlans,
            strategy: "default",
            unitIndex: denseWorkUnitIndex,
            unitCount: denseWorkUnitCount,
            busId: candidateBus.busId,
          })
          yield
        }
        if (selectedBusIndex < 0) {
          matchedRoutingSucceeded = false
          break
        }
        remainingBoundaryBuses.splice(selectedBusIndex, 1)
      }
      let matchedPlaneBusesInRoutingOrder: PreparedBus[] | null = null
      if (matchedRoutingSucceeded) {
        let feasibleViaPoints: Map<number, { x: number; y: number }> | null =
          null
        let feasibleAlternatePlanePlans: FanoutRoutePlan[] = []
        const matchViaPointsAroundPlans = (
          candidatePlans: readonly FanoutRoutePlan[],
        ): Map<number, { x: number; y: number }> | null => {
          feasibleAlternatePlanePlans = []
          const fixedBoundaryViaPoints = new Map(
            candidatePlans.flatMap((plan) =>
              plan.via
                ? [[plan.connectionIndex, plan.via.center] as const]
                : [],
            ),
          )
          const blockingSegments = candidatePlans.flatMap((plan) =>
            plan.segments.map((segment) => ({
              connectionIndex: plan.connectionIndex,
              segment,
            })),
          )
          const boundaryBusesToMatch = useConfiguredDensePlaneRouting
            ? boundaryBuses
            : []
          const blockingVias = useConfiguredDensePlaneRouting
            ? []
            : candidatePlans.flatMap((plan) =>
                [
                  plan.via,
                  ...(plan.additionalVias ?? []),
                  plan.planeEndpointVia,
                ]
                  .filter((via) => via !== undefined)
                  .map((via) => ({
                    connectionIndex: plan.connectionIndex,
                    center: via!.center,
                    diameter: via!.diameter,
                    spanLayers: via!.spanLayers,
                  })),
              )
          // Completed boundary paths can reach their via with several source-
          // layer segments. Treat their actual copper as fixed obstacles instead
          // of reinterpreting each as a straight pad-to-via dogbone.
          const retainedViaPoints = useConfiguredDensePlaneRouting
            ? null
            : matchComponentDogboneViaSites(planeBuses, {
                viaDiameter: this.config.viaDiameter,
                viaHoleDiameter: this.config.viaHoleDiameter,
                traceWidth: this.config.traceWidth,
                clearance: this.config.clearance,
                maximumSearchStates: 1,
                preferredBoundaryPerpendicularSideByBusId,
                preferBoundaryOutwardByBusId,
                fixedViaPointsByConnectionIndex: new Map([
                  ...fixedViaPointsByConnectionIndex,
                  ...fixedBoundaryViaPoints,
                ]),
                blockingSegments,
                blockingVias,
                additionalObstacles: denseAdditionalObstacles,
                preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
                canShareCopper,
              })
          if (retainedViaPoints)
            return new Map([...fixedBoundaryViaPoints, ...retainedViaPoints])
          if (
            useConfiguredDensePlaneRouting ||
            process.env.FANOUT_DEBUG_INCREMENTAL_PLANE_MATCH === "1"
          ) {
            let incrementalViaPoints = new Map(fixedBoundaryViaPoints)
            const matchedPlaneBuses = [...activeBoundaryReservationPlaneBuses]
            for (const planeBus of matchedPlaneBuses) {
              for (const connection of planeBus.connections) {
                const reservedPoint = fixedViaPointsByConnectionIndex.get(
                  connection.connectionIndex,
                )
                if (reservedPoint) {
                  incrementalViaPoints.set(
                    connection.connectionIndex,
                    reservedPoint,
                  )
                }
              }
            }
            for (const planeBus of matchedPlaneBuses) {
              const targetLayer = params.busLayerAssignments[planeBus.busId]
              if (!targetLayer) return null
              const reservedPlanePlans = routeBus({
                srj: this.routingSrj,
                bus: planeBus,
                targetLayer,
                acceptedPlans: [
                  ...candidatePlans,
                  ...feasibleAlternatePlanePlans,
                ],
                layerNames: this.config.layerNames,
                traceWidth: this.config.traceWidth,
                viaDiameter: this.config.viaDiameter,
                viaHoleDiameter: this.config.viaHoleDiameter,
                clearance: this.config.clearance,
                compactBusTracks: this.config.compactBusTracks,
                allowBlindAndBuriedVias: false,
                allowSameNetMerges: this.config.allowSameNetMerges,
                staticClearanceCache: this.routeStaticClearanceCache,
                fixedViaPointsByConnectionIndex: incrementalViaPoints,
              })
              if (!reservedPlanePlans) return null
              feasibleAlternatePlanePlans.push(...reservedPlanePlans)
            }
            const independentlyUnmatchablePlaneBuses = planeBuses.filter(
              (planeBus) =>
                !matchedPlaneBuses.includes(planeBus) &&
                !matchComponentDogboneViaSites(
                  [...matchedPlaneBuses, planeBus, ...boundaryBusesToMatch],
                  {
                    viaDiameter: this.config.viaDiameter,
                    viaHoleDiameter: this.config.viaHoleDiameter,
                    traceWidth: this.config.traceWidth,
                    clearance: this.config.clearance,
                    maximumSearchStates: 100_000,
                    preferredBoundaryPerpendicularSideByBusId,
                    preferBoundaryOutwardByBusId,
                    fixedViaPointsByConnectionIndex: incrementalViaPoints,
                    blockingSegments,
                    blockingVias,
                    additionalObstacles: denseAdditionalObstacles,
                    preferPlaneCheckerboardSites:
                      useConfiguredDensePlaneRouting,
                    canShareCopper,
                  },
                ),
            )
            const shallowestPlaneLayerIndex = Math.min(
              ...planeBuses.map((bus) =>
                this.config.layerNames.indexOf(
                  params.busLayerAssignments[bus.busId] ?? "",
                ),
              ),
            )
            const deeperPlaneBuses =
              useConfiguredDensePlaneRouting ||
              process.env.FANOUT_DEBUG_ROUTE_DEEP_PLANES_FIRST === "1"
                ? planeBuses.filter(
                    (bus) =>
                      !matchedPlaneBuses.includes(bus) &&
                      this.config.layerNames.indexOf(
                        params.busLayerAssignments[bus.busId] ?? "",
                      ) > shallowestPlaneLayerIndex,
                  )
                : []
            const additionalAlternatePlaneBusIds = new Set([
              ...this.config.denseUnrestrictedPlaneRoutingBusIds,
              ...(process.env.FANOUT_DEBUG_ADDITIONAL_ALTERNATE_PLANE_BUS_IDS?.split(
                ",",
              ) ?? []),
            ])
            const additionalAlternatePlaneBuses = planeBuses.filter(
              (bus) =>
                !matchedPlaneBuses.includes(bus) &&
                additionalAlternatePlaneBusIds.has(bus.busId),
            )
            const alternatePlaneBuses = [
              ...deeperPlaneBuses,
              ...independentlyUnmatchablePlaneBuses.filter(
                (bus) => !deeperPlaneBuses.includes(bus),
              ),
              ...additionalAlternatePlaneBuses.filter(
                (bus) =>
                  !deeperPlaneBuses.includes(bus) &&
                  !independentlyUnmatchablePlaneBuses.includes(bus),
              ),
            ]
            const debugAlternatePlaneOrder =
              process.env.FANOUT_DEBUG_ALTERNATE_PLANE_ORDER?.split(",") ?? []
            const orderedAlternatePlaneBuses = alternatePlaneBuses.toSorted(
              (first, second) => {
                const firstLayerIndex = this.config.layerNames.indexOf(
                  params.busLayerAssignments[first.busId] ?? "",
                )
                const secondLayerIndex = this.config.layerNames.indexOf(
                  params.busLayerAssignments[second.busId] ?? "",
                )
                if (
                  firstLayerIndex !== secondLayerIndex &&
                  process.env.FANOUT_DEBUG_ALTERNATE_IGNORE_LAYERS !== "1"
                ) {
                  return process.env.FANOUT_DEBUG_ALTERNATE_SHALLOW_FIRST ===
                    "1"
                    ? firstLayerIndex - secondLayerIndex
                    : secondLayerIndex - firstLayerIndex
                }
                const firstPriority = debugAlternatePlaneOrder.indexOf(
                  first.busId,
                )
                const secondPriority = debugAlternatePlaneOrder.indexOf(
                  second.busId,
                )
                return (
                  (firstPriority < 0
                    ? debugAlternatePlaneOrder.length
                    : firstPriority) -
                    (secondPriority < 0
                      ? debugAlternatePlaneOrder.length
                      : secondPriority) ||
                  first.connections[0]!.connectionIndex -
                    second.connections[0]!.connectionIndex
                )
              },
            )
            if (alternatePlaneBuses.length > 0) {
              debugDense(
                "plane-match:preflight-failed",
                independentlyUnmatchablePlaneBuses.map((bus) => bus.busId),
              )
              if (
                !useConfiguredDensePlaneRouting &&
                process.env.FANOUT_DEBUG_ROUTE_UNMATCHED_PLANES !== "1"
              ) {
                return null
              }
              let alternatePlaneSearchStates = 0
              const maximumAlternatePlaneSearchStates = Number(
                process.env.FANOUT_DEBUG_ALTERNATE_SEARCH_STATES ??
                  (useConfiguredDensePlaneRouting ? 3_000_000 : 1_000),
              )
              const maximumAlternatePlaneRoutes = Number(
                process.env.FANOUT_DEBUG_ALTERNATE_ROUTE_COUNT ??
                  (useConfiguredDensePlaneRouting ? 128 : 8),
              )
              let deepestAlternatePlaneSearchIndex = 0
              const alternatePlaneFailureCountByBusId = new Map<
                string,
                number
              >()
              const getPlaneRouteAlternatives = (
                planeBus: PreparedBus,
                additionalAcceptedPlans: FanoutRoutePlan[],
                maximumRoutes = maximumAlternatePlaneRoutes,
              ): FanoutRoutePlan[][] => {
                const targetLayer = params.busLayerAssignments[planeBus.busId]
                if (!targetLayer) return []
                return routeBusAlternatives(
                  {
                    srj: this.routingSrj,
                    bus: planeBus,
                    targetLayer,
                    acceptedPlans: [
                      ...candidatePlans,
                      ...additionalAcceptedPlans,
                    ],
                    layerNames: this.config.layerNames,
                    traceWidth: this.config.traceWidth,
                    viaDiameter: this.config.viaDiameter,
                    viaHoleDiameter: this.config.viaHoleDiameter,
                    clearance: this.config.clearance,
                    compactBusTracks: this.config.compactBusTracks,
                    allowBlindAndBuriedVias: false,
                    allowSameNetMerges: this.config.allowSameNetMerges,
                    staticClearanceCache: this.routeStaticClearanceCache,
                  },
                  maximumRoutes,
                )
              }
              const routeAlternatePlaneBuses = (
                remainingPlaneBuses: PreparedBus[],
                acceptedAlternatePlans: FanoutRoutePlan[],
              ): FanoutRoutePlan[] | null => {
                if (remainingPlaneBuses.length === 0) {
                  return acceptedAlternatePlans
                }
                if (
                  alternatePlaneSearchStates >=
                  maximumAlternatePlaneSearchStates
                ) {
                  return null
                }
                deepestAlternatePlaneSearchIndex = Math.max(
                  deepestAlternatePlaneSearchIndex,
                  orderedAlternatePlaneBuses.length -
                    remainingPlaneBuses.length,
                )
                const alternativesByBus = remainingPlaneBuses.map(
                  (planeBus) => ({
                    planeBus,
                    alternatives: getPlaneRouteAlternatives(
                      planeBus,
                      acceptedAlternatePlans,
                    ),
                  }),
                )
                const orderedSelections =
                  process.env.FANOUT_DEBUG_DYNAMIC_ALTERNATE_ORDER === "1"
                    ? alternativesByBus.toSorted(
                        (first, second) =>
                          first.alternatives.length -
                            second.alternatives.length ||
                          orderedAlternatePlaneBuses.indexOf(first.planeBus) -
                            orderedAlternatePlaneBuses.indexOf(second.planeBus),
                      )
                    : alternativesByBus
                const selected = orderedSelections[0]!
                const { planeBus, alternatives } = selected
                if (
                  process.env.FANOUT_DEBUG_ALTERNATE_CHOICES === "1" &&
                  alternatePlaneSearchStates < 64
                ) {
                  debugDense(
                    "plane-route:alternate-choice",
                    `depth:${orderedAlternatePlaneBuses.length - remainingPlaneBuses.length}`,
                    planeBus.busId,
                    alternativesByBus.map((entry) => [
                      entry.planeBus.busId,
                      entry.alternatives.length,
                    ]),
                  )
                }
                if (alternatives.length === 0) {
                  alternatePlaneFailureCountByBusId.set(
                    planeBus.busId,
                    (alternatePlaneFailureCountByBusId.get(planeBus.busId) ??
                      0) + 1,
                  )
                  return null
                }
                const selectionsToSearch =
                  process.env.FANOUT_DEBUG_BRANCH_ALTERNATE_ORDER === "1"
                    ? orderedSelections
                    : [selected]
                const alternateActions = selectionsToSearch.flatMap(
                  (selection) =>
                    selection.alternatives.map((alternative) => ({
                      selection,
                      alternative,
                      remaining: remainingPlaneBuses.filter(
                        (candidate) => candidate !== selection.planeBus,
                      ),
                    })),
                )
                const orderedActions =
                  process.env.FANOUT_DEBUG_LEAST_CONSTRAINING_ALTERNATES === "1"
                    ? alternateActions
                        .map((action) => {
                          const acceptedPlans = [
                            ...acceptedAlternatePlans,
                            ...action.alternative,
                          ]
                          const remainingOptionCounts = action.remaining.map(
                            (remainingBus) =>
                              getPlaneRouteAlternatives(
                                remainingBus,
                                acceptedPlans,
                                Math.min(4, maximumAlternatePlaneRoutes),
                              ).length,
                          )
                          return {
                            ...action,
                            remainingOptionCounts,
                            minimumRemainingOptions:
                              remainingOptionCounts.length === 0
                                ? Number.POSITIVE_INFINITY
                                : Math.min(...remainingOptionCounts),
                            totalRemainingOptions: remainingOptionCounts.reduce(
                              (total, count) => total + count,
                              0,
                            ),
                          }
                        })
                        .filter(
                          (action) => action.minimumRemainingOptions !== 0,
                        )
                        .toSorted(
                          (first, second) =>
                            second.minimumRemainingOptions -
                              first.minimumRemainingOptions ||
                            second.totalRemainingOptions -
                              first.totalRemainingOptions,
                        )
                    : alternateActions
                for (const action of orderedActions) {
                  alternatePlaneSearchStates++
                  const completedPlans = routeAlternatePlaneBuses(
                    action.remaining,
                    [...acceptedAlternatePlans, ...action.alternative],
                  )
                  if (completedPlans) return completedPlans
                  if (
                    alternatePlaneSearchStates >=
                    maximumAlternatePlaneSearchStates
                  ) {
                    break
                  }
                }
                alternatePlaneFailureCountByBusId.set(
                  planeBus.busId,
                  (alternatePlaneFailureCountByBusId.get(planeBus.busId) ?? 0) +
                    1,
                )
                return null
              }
              let alternatePlanePlans: FanoutRoutePlan[] | null
              if (
                useConfiguredDensePlaneRouting ||
                process.env.FANOUT_DEBUG_EXACT_COVER_ALTERNATES === "1"
              ) {
                type IndependentPlaneRouteCandidate = {
                  key: string
                  planeBus: PreparedBus
                  plans: FanoutRoutePlan[]
                }
                const candidateSets = orderedAlternatePlaneBuses.map(
                  (planeBus) => ({
                    planeBus,
                    candidates: getPlaneRouteAlternatives(
                      planeBus,
                      feasibleAlternatePlanePlans,
                    ).map((plans, index) => ({
                      key: `${planeBus.busId}:${index}`,
                      planeBus,
                      plans,
                    })),
                  }),
                )
                debugDense(
                  "plane-route:alternate-candidate-counts",
                  candidateSets.map((candidateSet) => [
                    candidateSet.planeBus.busId,
                    candidateSet.candidates.length,
                  ]),
                )
                const compatibilityByCandidatePair = new Map<string, boolean>()
                const candidatesAreCompatible = (
                  first: IndependentPlaneRouteCandidate,
                  second: IndependentPlaneRouteCandidate,
                ): boolean => {
                  const cacheKey = [first.key, second.key].toSorted().join("|")
                  const cached = compatibilityByCandidatePair.get(cacheKey)
                  if (cached !== undefined) return cached
                  const compatible = fanoutPlansAreMutuallyClear({
                    plans: [...first.plans, ...second.plans],
                    srj: this.routingSrj,
                    clearance: this.config.clearance,
                    allowSameNetMerges: this.config.allowSameNetMerges,
                  })
                  compatibilityByCandidatePair.set(cacheKey, compatible)
                  return compatible
                }
                const selectCompatiblePlaneRoutes = (
                  remainingCandidateSets: typeof candidateSets,
                  selectedCandidates: IndependentPlaneRouteCandidate[],
                ): IndependentPlaneRouteCandidate[] | null => {
                  if (remainingCandidateSets.length === 0) {
                    return selectedCandidates
                  }
                  if (
                    alternatePlaneSearchStates >=
                    maximumAlternatePlaneSearchStates
                  ) {
                    return null
                  }
                  deepestAlternatePlaneSearchIndex = Math.max(
                    deepestAlternatePlaneSearchIndex,
                    orderedAlternatePlaneBuses.length -
                      remainingCandidateSets.length,
                  )
                  const selectedSet = remainingCandidateSets.toSorted(
                    (first, second) =>
                      first.candidates.length - second.candidates.length,
                  )[0]!
                  if (selectedSet.candidates.length === 0) {
                    alternatePlaneFailureCountByBusId.set(
                      selectedSet.planeBus.busId,
                      (alternatePlaneFailureCountByBusId.get(
                        selectedSet.planeBus.busId,
                      ) ?? 0) + 1,
                    )
                    return null
                  }
                  const otherSets = remainingCandidateSets.filter(
                    (candidateSet) => candidateSet !== selectedSet,
                  )
                  const candidateBatchSize = Number(
                    process.env.FANOUT_DEBUG_ALTERNATE_CANDIDATE_BATCH_SIZE ??
                      16,
                  )
                  for (
                    let batchStart = 0;
                    batchStart < selectedSet.candidates.length;
                    batchStart += candidateBatchSize
                  ) {
                    const actions = selectedSet.candidates
                      .slice(batchStart, batchStart + candidateBatchSize)
                      .map((candidate) => {
                        const projectedSets = otherSets.map((candidateSet) => ({
                          ...candidateSet,
                          candidates: candidateSet.candidates.filter(
                            (otherCandidate) =>
                              candidatesAreCompatible(
                                candidate,
                                otherCandidate,
                              ),
                          ),
                        }))
                        const projectedCounts = projectedSets.map(
                          (candidateSet) => candidateSet.candidates.length,
                        )
                        return {
                          candidate,
                          projectedSets,
                          minimumProjectedCount:
                            projectedCounts.length === 0
                              ? Number.POSITIVE_INFINITY
                              : Math.min(...projectedCounts),
                          totalProjectedCount: projectedCounts.reduce(
                            (total, count) => total + count,
                            0,
                          ),
                        }
                      })
                      .filter((action) => action.minimumProjectedCount !== 0)
                      .toSorted(
                        (first, second) =>
                          second.minimumProjectedCount -
                            first.minimumProjectedCount ||
                          second.totalProjectedCount -
                            first.totalProjectedCount,
                      )
                    for (const action of actions) {
                      alternatePlaneSearchStates++
                      const selected = selectCompatiblePlaneRoutes(
                        action.projectedSets,
                        [...selectedCandidates, action.candidate],
                      )
                      if (selected) return selected
                      if (
                        alternatePlaneSearchStates >=
                        maximumAlternatePlaneSearchStates
                      ) {
                        break
                      }
                    }
                    if (
                      alternatePlaneSearchStates >=
                      maximumAlternatePlaneSearchStates
                    ) {
                      break
                    }
                  }
                  alternatePlaneFailureCountByBusId.set(
                    selectedSet.planeBus.busId,
                    (alternatePlaneFailureCountByBusId.get(
                      selectedSet.planeBus.busId,
                    ) ?? 0) + 1,
                  )
                  return null
                }
                const selectedCandidates = selectCompatiblePlaneRoutes(
                  candidateSets,
                  [],
                )
                alternatePlanePlans = selectedCandidates
                  ? [
                      ...feasibleAlternatePlanePlans,
                      ...selectedCandidates.flatMap(
                        (candidate) => candidate.plans,
                      ),
                    ]
                  : null
              } else {
                alternatePlanePlans = routeAlternatePlaneBuses(
                  orderedAlternatePlaneBuses,
                  feasibleAlternatePlanePlans,
                )
              }
              debugDense(
                "plane-route:alternate-search",
                alternatePlanePlans ? "complete" : "failed",
                alternatePlaneSearchStates,
                `depth:${deepestAlternatePlaneSearchIndex}/${orderedAlternatePlaneBuses.length}`,
                [...alternatePlaneFailureCountByBusId].toSorted(
                  ([, first], [, second]) => second - first,
                ),
              )
              if (!alternatePlanePlans) return null
              feasibleAlternatePlanePlans = alternatePlanePlans
            }
            let planeBusIdsRoutedWithoutDogbones = new Set<string>()
            let allBlockingSegments = [...blockingSegments]
            let alternateBlockingVias: {
              connectionIndex: number
              center: { x: number; y: number }
              diameter: number
              spanLayers: readonly string[]
            }[] = []
            let planeBusesToMatch = [...planeBuses]
            let candidateCountByConnectionIndex = new Map<number, number>()
            let candidatePointsByConnectionIndex = new Map<
              number,
              { x: number; y: number }[]
            >()
            const refreshPlaneDogboneCandidates = (): void => {
              planeBusIdsRoutedWithoutDogbones = new Set(
                feasibleAlternatePlanePlans.map((plan) => plan.busId),
              )
              const alternateBlockingSegments =
                feasibleAlternatePlanePlans.flatMap((plan) =>
                  [...plan.segments, ...(plan.planeEndpointSegments ?? [])].map(
                    (segment) => ({
                      connectionIndex: plan.connectionIndex,
                      segment,
                    }),
                  ),
                )
              allBlockingSegments = [
                ...blockingSegments,
                ...alternateBlockingSegments,
              ]
              alternateBlockingVias = feasibleAlternatePlanePlans.flatMap(
                (plan) =>
                  [
                    plan.via,
                    ...(plan.additionalVias ?? []),
                    plan.planeEndpointVia,
                  ].flatMap((via) =>
                    via
                      ? [
                          {
                            connectionIndex: plan.connectionIndex,
                            center: via.center,
                            diameter: via.diameter,
                            spanLayers: via.spanLayers,
                          },
                        ]
                      : [],
                  ),
              )
              planeBusesToMatch = planeBuses.filter(
                (bus) => !planeBusIdsRoutedWithoutDogbones.has(bus.busId),
              )
              candidateCountByConnectionIndex = new Map()
              candidatePointsByConnectionIndex = new Map()
              for (const candidate of getComponentDogboneViaSiteCandidates(
                planeBusesToMatch,
                {
                  viaDiameter: this.config.viaDiameter,
                  viaHoleDiameter: this.config.viaHoleDiameter,
                  traceWidth: this.config.traceWidth,
                  clearance: this.config.clearance,
                  blockingSegments: allBlockingSegments,
                  blockingVias: alternateBlockingVias,
                  additionalObstacles: denseAdditionalObstacles,
                  preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
                  canShareCopper,
                },
              )) {
                candidateCountByConnectionIndex.set(
                  candidate.connectionIndex,
                  (candidateCountByConnectionIndex.get(
                    candidate.connectionIndex,
                  ) ?? 0) + 1,
                )
                const points =
                  candidatePointsByConnectionIndex.get(
                    candidate.connectionIndex,
                  ) ?? []
                points.push(candidate.point)
                candidatePointsByConnectionIndex.set(
                  candidate.connectionIndex,
                  points,
                )
              }
            }
            refreshPlaneDogboneCandidates()
            for (
              let promotionPass = 0;
              promotionPass < planeBuses.length;
              promotionPass++
            ) {
              const zeroCandidatePlaneBuses = planeBusesToMatch.filter(
                (bus) =>
                  !candidateCountByConnectionIndex.has(
                    bus.connections[0]!.connectionIndex,
                  ),
              )
              if (zeroCandidatePlaneBuses.length === 0) break
              debugDense(
                "plane-route:promote-zero-candidates",
                zeroCandidatePlaneBuses.map((bus) => bus.busId),
              )
              if (
                zeroCandidatePlaneBuses.some((bus) =>
                  matchedPlaneBuses.includes(bus),
                )
              ) {
                return null
              }
              for (const planeBus of zeroCandidatePlaneBuses) {
                const targetLayer = params.busLayerAssignments[planeBus.busId]
                if (!targetLayer) return null
                const promotedPlans = routeBusAlternatives(
                  {
                    srj: this.routingSrj,
                    bus: planeBus,
                    targetLayer,
                    acceptedPlans: [
                      ...candidatePlans,
                      ...feasibleAlternatePlanePlans,
                    ],
                    layerNames: this.config.layerNames,
                    traceWidth: this.config.traceWidth,
                    viaDiameter: this.config.viaDiameter,
                    viaHoleDiameter: this.config.viaHoleDiameter,
                    clearance: this.config.clearance,
                    compactBusTracks: this.config.compactBusTracks,
                    allowBlindAndBuriedVias: false,
                    allowSameNetMerges: this.config.allowSameNetMerges,
                    staticClearanceCache: this.routeStaticClearanceCache,
                  },
                  8,
                )[0]
                if (!promotedPlans) {
                  debugDense("plane-route:promote-failed", planeBus.busId)
                  return null
                }
                feasibleAlternatePlanePlans.push(...promotedPlans)
              }
              refreshPlaneDogboneCandidates()
            }
            const debugPlaneMatchOrder =
              process.env.FANOUT_DEBUG_PLANE_MATCH_ORDER?.split(",") ?? []
            const incrementalPlaneBuses = planeBusesToMatch.toSorted(
              (first, second) => {
                const candidateCountDifference =
                  (candidateCountByConnectionIndex.get(
                    first.connections[0]!.connectionIndex,
                  ) ?? 0) -
                  (candidateCountByConnectionIndex.get(
                    second.connections[0]!.connectionIndex,
                  ) ?? 0)
                if (candidateCountDifference !== 0) {
                  return candidateCountDifference
                }
                const firstPriority = debugPlaneMatchOrder.indexOf(first.busId)
                const secondPriority = debugPlaneMatchOrder.indexOf(
                  second.busId,
                )
                const priorityDifference =
                  (firstPriority < 0
                    ? debugPlaneMatchOrder.length
                    : firstPriority) -
                  (secondPriority < 0
                    ? debugPlaneMatchOrder.length
                    : secondPriority)
                if (priorityDifference !== 0) return priorityDifference
                return (
                  first.connections[0]!.connectionIndex -
                  second.connections[0]!.connectionIndex
                )
              },
            )
            for (const planeBus of incrementalPlaneBuses) {
              if (matchedPlaneBuses.includes(planeBus)) continue
              if (
                process.env.FANOUT_DEBUG_PLANE_CANDIDATES?.split(",").includes(
                  planeBus.busId,
                )
              ) {
                debugDense(
                  "plane-match:candidates",
                  planeBus.busId,
                  candidatePointsByConnectionIndex.get(
                    planeBus.connections[0]!.connectionIndex,
                  ),
                )
              }
              const nextViaPoints = matchComponentDogboneViaSites(
                [...matchedPlaneBuses, planeBus, ...boundaryBusesToMatch],
                {
                  viaDiameter: this.config.viaDiameter,
                  viaHoleDiameter: this.config.viaHoleDiameter,
                  traceWidth: this.config.traceWidth,
                  clearance: this.config.clearance,
                  maximumSearchStates: 100_000,
                  preferredBoundaryPerpendicularSideByBusId,
                  preferBoundaryOutwardByBusId,
                  fixedViaPointsByConnectionIndex: incrementalViaPoints,
                  blockingSegments: allBlockingSegments,
                  blockingVias: [...blockingVias, ...alternateBlockingVias],
                  additionalObstacles: denseAdditionalObstacles,
                  preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
                  canShareCopper,
                },
              )
              debugDense(
                nextViaPoints
                  ? "plane-match:incremental"
                  : "plane-match:incremental-failed",
                planeBus.busId,
                candidateCountByConnectionIndex.get(
                  planeBus.connections[0]!.connectionIndex,
                ) ?? 0,
                nextViaPoints?.get(planeBus.connections[0]!.connectionIndex),
                nextViaPoints?.size ?? "failed",
              )
              if (!nextViaPoints) return null
              incrementalViaPoints = new Map([
                ...incrementalViaPoints,
                ...nextViaPoints,
              ])
              matchedPlaneBuses.push(planeBus)
            }
            matchedPlaneBusesInRoutingOrder = matchedPlaneBuses.filter(
              (bus) => !planeBusIdsRoutedWithoutDogbones.has(bus.busId),
            )
            debugDense(
              "plane-match:incremental-complete",
              incrementalViaPoints.size,
            )
            return incrementalViaPoints
          }
          const planeViaPoints = matchComponentDogboneViaSites(
            [...planeBuses, ...boundaryBusesToMatch],
            {
              viaDiameter: this.config.viaDiameter,
              viaHoleDiameter: this.config.viaHoleDiameter,
              traceWidth: this.config.traceWidth,
              clearance: this.config.clearance,
              maximumSearchStates: 100_000,
              preferredBoundaryPerpendicularSideByBusId,
              preferBoundaryOutwardByBusId,
              fixedViaPointsByConnectionIndex: fixedBoundaryViaPoints,
              blockingSegments,
              blockingVias,
              additionalObstacles: denseAdditionalObstacles,
              preferPlaneCheckerboardSites: useConfiguredDensePlaneRouting,
              canShareCopper,
            },
          )
          return planeViaPoints
            ? new Map([...fixedBoundaryViaPoints, ...planeViaPoints])
            : null
        }
        debugDense("length-match:start", matchedPlans.length)
        const matchedLengthResult = matchLengthsAfterPlanes
          ? { plans: matchedPlans }
          : matchBusPlanLengths({
              plans: matchedPlans,
              preparedBuses: this.preparedBuses,
              inputSrj: this.inputSrj,
              sharedBoundary: this.getValidationBoundary(),
              clearance: this.config.clearance,
              allowBlindAndBuriedVias: false,
              allowSameNetMerges: this.config.allowSameNetMerges,
              allowMatchingInsideDenseBounds: true,
              candidatePlansAreFeasible: (candidatePlans) => {
                const candidateViaPoints =
                  matchViaPointsAroundPlans(candidatePlans)
                if (!candidateViaPoints) return false
                feasibleViaPoints = candidateViaPoints
                return true
              },
            })
        debugDense(
          "length-match:complete",
          matchedLengthResult.plans?.length ?? "failed",
        )
        this.setInProgressPlans({
          phase: "match-dense-boundary-lengths",
          plans: matchedLengthResult.plans ?? matchedPlans,
          strategy: "default",
          unitIndex: ++denseWorkUnitIndex,
          unitCount: denseWorkUnitCount,
        })
        yield
        if (matchedLengthResult.plans) {
          matchedPlans = matchedLengthResult.plans
          const rematchedViaPoints =
            feasibleViaPoints ?? matchViaPointsAroundPlans(matchedPlans)
          if (rematchedViaPoints) {
            fixedViaPointsByConnectionIndex = rematchedViaPoints
            matchedPlans.push(...feasibleAlternatePlanePlans)
          } else {
            matchedRoutingSucceeded = false
          }
        } else {
          matchedRoutingSucceeded = false
        }
        this.setInProgressPlans({
          phase: "rematch-dense-via-sites",
          plans: matchedPlans,
          strategy: "default",
          unitIndex: denseWorkUnitIndex,
          unitCount: denseWorkUnitCount,
        })
        yield
      }
      if (matchedRoutingSucceeded) {
        for (const bus of matchedPlaneBusesInRoutingOrder ?? planeBuses) {
          debugDense("plane-route:start", bus.busId)
          const targetLayer = params.busLayerAssignments[bus.busId]
          const blockingBusCounts = new Map<string, number>()
          const busPlans = targetLayer
            ? routeBus({
                srj: this.routingSrj,
                bus,
                targetLayer,
                acceptedPlans: matchedPlans,
                layerNames: this.config.layerNames,
                traceWidth: this.config.traceWidth,
                viaDiameter: this.config.viaDiameter,
                viaHoleDiameter: this.config.viaHoleDiameter,
                clearance: this.config.clearance,
                compactBusTracks: this.config.compactBusTracks,
                allowBlindAndBuriedVias: false,
                allowSameNetMerges: this.config.allowSameNetMerges,
                staticClearanceCache: this.routeStaticClearanceCache,
                blockingBusCounts,
                fixedViaPointsByConnectionIndex,
              })
            : null
          if (!busPlans) {
            debugDense(
              "plane-route:failed",
              bus.busId,
              fixedViaPointsByConnectionIndex.get(
                bus.connections[0]!.connectionIndex,
              ),
              [...blockingBusCounts],
            )
            matchedRoutingSucceeded = false
            break
          }
          matchedPlans.push(...busPlans)
          debugDense("plane-route:complete", bus.busId)
          this.setInProgressPlans({
            phase: "route-dense-plane-buses",
            plans: matchedPlans,
            strategy: "default",
            unitIndex: ++denseWorkUnitIndex,
            unitCount: denseWorkUnitCount,
            busId: bus.busId,
          })
          yield
        }
      }
      if (matchedRoutingSucceeded && matchLengthsAfterPlanes) {
        // With the configured plane escape strategy, route those dogbones
        // before tuning. Length matching can then check the actual complete
        // copper instead of repeatedly searching for a new plane assignment
        // for every prospective meander.
        const matchedLengthResult = matchBusPlanLengths({
          plans: matchedPlans,
          preparedBuses: this.preparedBuses,
          inputSrj: this.inputSrj,
          sharedBoundary: this.getValidationBoundary(),
          clearance: this.config.clearance,
          allowBlindAndBuriedVias: false,
          allowSameNetMerges: this.config.allowSameNetMerges,
          allowMatchingInsideDenseBounds: true,
        })
        if (matchedLengthResult.plans) {
          matchedPlans = matchedLengthResult.plans
        } else {
          matchedRoutingSucceeded = false
        }
        this.setInProgressPlans({
          phase: "match-dense-complete-lengths",
          plans: matchedPlans,
          strategy: "default",
          unitIndex: ++denseWorkUnitIndex,
          unitCount: denseWorkUnitCount,
        })
        yield
      }
      const densePlansAreClear =
        matchedRoutingSucceeded &&
        fanoutPlansAreClear({
          plans: matchedPlans,
          srj: this.routingSrj,
          sharedBoundary: boundaryBuses[0]!.sharedBoundary,
          clearance: this.config.clearance,
          allowBlindAndBuriedVias: false,
          allowSameNetMerges: this.config.allowSameNetMerges,
        })
      debugDense(
        "dense-validation",
        matchedRoutingSucceeded,
        matchedPlans.length,
        densePlansAreClear,
      )
      if (densePlansAreClear) {
        return { plans: matchedPlans, failedBusIds: [] }
      }
    }

    if (matchLengthsAfterPlanes) {
      return yield* this.routeDenseThroughAllMixedTerminationSteps({
        ...params,
        lengthMatchingStage: "before-planes",
      })
    }

    // Pad-aligned windings can fence off a same-layer singleton even when
    // every wide bus routes successfully. Before widening the search, retry
    // the coordinated reservation with a boundary-aligned grid and let those
    // singleton sites remain provisional until surrounding copper is fixed.
    if (usePadAlignedDenseRouting && !useConfiguredDensePlaneRouting) {
      const boundaryAlignedState =
        yield* this.routeDenseThroughAllMixedTerminationSteps({
          ...params,
          denseRoutingStrategy: "boundary-aligned",
        })
      if (boundaryAlignedState) return boundaryAlignedState
    }
    if (
      !usePadAlignedDenseRouting ||
      process.env.FANOUT_DEBUG_DENSE_ONLY === "1"
    )
      return null

    const maximumStates = 8
    const getBoundaryStates = (
      alternativesPerBoundaryBus: number,
      initialPlans: readonly FanoutRoutePlan[] = [],
    ): MixedTerminationState[] | null => {
      let states: MixedTerminationState[] = [
        { plans: [...initialPlans], failedBusIds: [] },
      ]
      for (const bus of boundaryBuses) {
        const targetLayer = params.busLayerAssignments[bus.busId]
        if (!targetLayer) return null
        const nextStates: MixedTerminationState[] = []
        const alternativesByState = states.map((state) => ({
          state,
          alternatives: routeBusAlternatives(
            {
              srj: this.routingSrj,
              bus,
              targetLayer,
              acceptedPlans: state.plans,
              layerNames: this.config.layerNames,
              traceWidth: this.config.traceWidth,
              viaDiameter: this.config.viaDiameter,
              viaHoleDiameter: this.config.viaHoleDiameter,
              clearance: this.config.clearance,
              compactBusTracks: this.config.compactBusTracks,
              allowBlindAndBuriedVias: false,
              allowSameNetMerges: this.config.allowSameNetMerges,
              staticClearanceCache: this.routeStaticClearanceCache,
            },
            alternativesPerBoundaryBus,
          ),
        }))
        for (
          let alternativeIndex = 0;
          alternativeIndex < alternativesPerBoundaryBus;
          alternativeIndex++
        ) {
          for (const { state, alternatives } of alternativesByState) {
            const alternative = alternatives[alternativeIndex]
            if (!alternative) continue
            nextStates.push({
              plans: [...state.plans, ...alternative],
              failedBusIds: [],
            })
            if (nextStates.length >= maximumStates) break
          }
          if (nextStates.length >= maximumStates) break
        }
        if (nextStates.length === 0) return null
        states = nextStates
      }
      return states
    }

    const getJointReservedBoundaryState = (
      initialPlans: readonly FanoutRoutePlan[],
    ): MixedTerminationState | null => {
      if (boundaryBuses.length !== 2) return null
      const [firstBus, secondBus] = boundaryBuses
      if (!firstBus || !secondBus) return null
      const routeBoundaryBus = (
        bus: PreparedBus,
        acceptedPlans: FanoutRoutePlan[],
        rejectedViaMinimalCandidates?: FanoutRoutePlan[][],
      ): FanoutRoutePlan[] | null => {
        const targetLayer = params.busLayerAssignments[bus.busId]
        if (!targetLayer) return null
        return (
          routeBusAlternatives(
            {
              srj: this.routingSrj,
              bus,
              targetLayer,
              acceptedPlans,
              layerNames: this.config.layerNames,
              traceWidth: this.config.traceWidth,
              viaDiameter: this.config.viaDiameter,
              viaHoleDiameter: this.config.viaHoleDiameter,
              clearance: this.config.clearance,
              compactBusTracks: this.config.compactBusTracks,
              allowBlindAndBuriedVias: false,
              allowSameNetMerges: this.config.allowSameNetMerges,
              staticClearanceCache: this.routeStaticClearanceCache,
              rejectedViaMinimalCandidates,
              stopAfterFirstRejectedViaMinimalCandidate:
                rejectedViaMinimalCandidates !== undefined,
            },
            1,
          )[0] ?? null
        )
      }

      const firstPlans = routeBoundaryBus(firstBus, [...initialPlans])
      if (!firstPlans) return null
      const rejectedSecondCandidates: FanoutRoutePlan[][] = []
      const secondPlans = routeBoundaryBus(
        secondBus,
        [...initialPlans, ...firstPlans],
        rejectedSecondCandidates,
      )
      if (secondPlans) {
        return {
          plans: [...initialPlans, ...firstPlans, ...secondPlans],
          failedBusIds: [],
        }
      }

      const rejectedSecondPlans = rejectedSecondCandidates[0]
      if (!rejectedSecondPlans) return null
      // Keep the candidate's exact copper/vias as immutable blockers while
      // rerouting the earlier bus, but exclude it from corner-slot allocation.
      const reservedSecondPlans = rejectedSecondPlans.map((plan) => ({
        ...plan,
        termination: {
          type: "plane" as const,
          layer: plan.targetLayer,
        },
      }))
      const reroutedFirstPlans = routeBoundaryBus(firstBus, [
        ...initialPlans,
        ...reservedSecondPlans,
      ])
      if (!reroutedFirstPlans) return null
      const combinedPlans = [
        ...initialPlans,
        ...reroutedFirstPlans,
        ...rejectedSecondPlans,
      ]
      if (
        !fanoutPlansAreClear({
          plans: combinedPlans,
          srj: this.routingSrj,
          sharedBoundary: firstBus.sharedBoundary,
          clearance: this.config.clearance,
          allowBlindAndBuriedVias: false,
          allowSameNetMerges: this.config.allowSameNetMerges,
        })
      ) {
        return null
      }
      return { plans: combinedPlans, failedBusIds: [] }
    }

    const planeBusById = new Map(planeBuses.map((bus) => [bus.busId, bus]))
    const routePlaneBus = (
      bus: PreparedBus,
      acceptedPlans: FanoutRoutePlan[],
      blockingBusCounts?: Map<string, number>,
    ): FanoutRoutePlan[] | null => {
      const targetLayer = params.busLayerAssignments[bus.busId]
      if (!targetLayer) return null
      return routeBus({
        srj: this.routingSrj,
        bus,
        targetLayer,
        acceptedPlans,
        layerNames: this.config.layerNames,
        traceWidth: this.config.traceWidth,
        viaDiameter: this.config.viaDiameter,
        viaHoleDiameter: this.config.viaHoleDiameter,
        clearance: this.config.clearance,
        compactBusTracks: this.config.compactBusTracks,
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: this.config.allowSameNetMerges,
        staticClearanceCache: this.routeStaticClearanceCache,
        blockingBusCounts,
      })
    }

    const routePlaneOrder = (
      boundaryPlans: readonly FanoutRoutePlan[],
      planeOrder: readonly PreparedBus[],
    ): MixedTerminationState => {
      const state: MixedTerminationState = {
        plans: [...boundaryPlans],
        failedBusIds: [],
      }
      for (const bus of planeOrder) {
        const blockingBusCounts = new Map<string, number>()
        let busPlans = routePlaneBus(bus, state.plans, blockingBusCounts)

        // A plane dogbone can lose its only local channel to one or two
        // earlier singleton drops. Rip up only the strongest local blockers,
        // route the constrained drop first, then put the displaced drops back.
        // Boundary buses are immutable here and the search is capped at 36
        // blocker pairs, so dense fields remain predictable.
        if (!busPlans) {
          const blockerIds = [...blockingBusCounts.entries()]
            .filter(([busId]) =>
              state.plans.some((plan) => plan.busId === busId),
            )
            .filter(([busId]) => planeBusById.has(busId))
            .toSorted(
              ([, firstCount], [, secondCount]) => secondCount - firstCount,
            )
            .slice(0, 8)
            .map(([busId]) => busId)
          const ripupSets = [
            ...blockerIds.map((busId) => [busId]),
            ...blockerIds.flatMap((first, firstIndex) =>
              blockerIds.slice(firstIndex + 1).map((second) => [first, second]),
            ),
          ]
          for (const ripupIds of ripupSets) {
            const ripupIdSet = new Set(ripupIds)
            const candidatePlans = state.plans.filter(
              (plan) => !ripupIdSet.has(plan.busId),
            )
            const constrainedPlans = routePlaneBus(bus, candidatePlans)
            if (!constrainedPlans) continue
            candidatePlans.push(...constrainedPlans)
            let repairSucceeded = true
            for (const blockerId of ripupIds) {
              const blockerBus = planeBusById.get(blockerId)
              const replacementPlans = blockerBus
                ? routePlaneBus(blockerBus, candidatePlans)
                : null
              if (!replacementPlans) {
                repairSucceeded = false
                break
              }
              candidatePlans.push(...replacementPlans)
            }
            if (!repairSucceeded) continue
            state.plans = candidatePlans
            busPlans = []
            break
          }
        }

        if (busPlans) state.plans.push(...busPlans)
        else state.failedBusIds.push(bus.busId)
      }
      return state
    }

    let bestState: MixedTerminationState | null = null
    let mostRecentBoundaryBestState: MixedTerminationState | null = null
    const evaluateBoundaryStates = (
      states: readonly MixedTerminationState[],
      initialPlaneOrder: readonly PreparedBus[],
    ): MixedTerminationState | null => {
      let localBestState: MixedTerminationState | null = null
      for (const boundaryState of states) {
        let planeOrder = [...initialPlaneOrder]
        const seenPlaneOrders = new Set<string>()
        for (let retryIndex = 0; retryIndex < 3; retryIndex++) {
          const orderKey = planeOrder.map((bus) => bus.busId).join("\u0000")
          if (seenPlaneOrders.has(orderKey)) break
          seenPlaneOrders.add(orderKey)
          const state = routePlaneOrder(boundaryState.plans, planeOrder)
          if (
            !bestState ||
            state.plans.length > bestState.plans.length ||
            (state.plans.length === bestState.plans.length &&
              state.failedBusIds.length < bestState.failedBusIds.length)
          ) {
            bestState = state
          }
          if (
            !localBestState ||
            state.plans.length > localBestState.plans.length ||
            (state.plans.length === localBestState.plans.length &&
              state.failedBusIds.length < localBestState.failedBusIds.length)
          ) {
            localBestState = state
          }
          if (state.failedBusIds.length === 0) return state
          const failedBusIds = new Set(state.failedBusIds)
          planeOrder = [
            ...state.failedBusIds.flatMap((busId) => {
              const bus = planeBusById.get(busId)
              return bus ? [bus] : []
            }),
            ...planeOrder.filter((bus) => !failedBusIds.has(bus.busId)),
          ]
        }
      }
      mostRecentBoundaryBestState = localBestState
      return null
    }

    // Most dense packages route with the first deterministic boundary choice.
    // Try that cheap path before widening the beam; eagerly generating four
    // complete A* variants per state can otherwise dominate runtime and memory.
    for (const alternativesPerBoundaryBus of [1, 4]) {
      const states = getBoundaryStates(alternativesPerBoundaryBus)
      if (!states) continue
      const completeState = evaluateBoundaryStates(states, planeBuses)
      if (completeState) return completeState

      // If a completed signal escape encloses one especially constrained
      // power pad, seed just that failed singleton first and recompute the
      // small boundary-bus set around its physical through barrel. This keeps
      // the search local without routing hundreds of plane drops before the
      // signal buses.
      const seedFailureIds = (
        bestState as MixedTerminationState | null
      )?.failedBusIds.slice(0, 3)
      if (alternativesPerBoundaryBus === 1 && seedFailureIds) {
        for (const failedBusId of seedFailureIds) {
          const seededPlanePlans: FanoutRoutePlan[] = []
          const seededPlaneBusIds = new Set<string>()
          let nextFailedBusId: string | undefined = failedBusId
          for (
            let seedDepth = 0;
            seedDepth < 3 && nextFailedBusId;
            seedDepth++
          ) {
            const failedPlaneBus = planeBusById.get(nextFailedBusId)
            if (!failedPlaneBus) break
            const nextSeedPlans = routePlaneBus(
              failedPlaneBus,
              seededPlanePlans,
            )
            if (!nextSeedPlans) break
            seededPlanePlans.push(...nextSeedPlans)
            seededPlaneBusIds.add(nextFailedBusId)
            const jointReservedBoundaryState =
              getJointReservedBoundaryState(seededPlanePlans)
            if (!jointReservedBoundaryState) break
            const jointCompleteState = evaluateBoundaryStates(
              [jointReservedBoundaryState],
              planeBuses.filter((bus) => !seededPlaneBusIds.has(bus.busId)),
            )
            if (jointCompleteState) return jointCompleteState
            const recentFailedBusIds = (
              mostRecentBoundaryBestState as MixedTerminationState | null
            )?.failedBusIds
            nextFailedBusId = recentFailedBusIds?.find(
              (busId) => !seededPlaneBusIds.has(busId),
            )
          }
          if (seededPlanePlans.length === 0) continue
          const seededBoundaryStates = getBoundaryStates(1, seededPlanePlans)
          if (!seededBoundaryStates) continue
          const seededCompleteState = evaluateBoundaryStates(
            seededBoundaryStates,
            planeBuses.filter((bus) => !seededPlaneBusIds.has(bus.busId)),
          )
          if (seededCompleteState) return seededCompleteState
        }
      }
    }

    return bestState
  }

  private *evaluateAssignmentWithStrategySteps(
    assignmentIndex: number,
    busLayerAssignments: Readonly<Record<string, string>>,
    routingStrategy: RoutingStrategy,
  ): Generator<FanoutWorkYield, EvaluatedAssignment, unknown> {
    let plans: AssignmentAttempt["plans"] = []
    let failedBusIds: string[] = []
    let blockingBusCounts = new Map<string, number>()
    const isSingleLayerFanout = this.config.escapeLayers.length === 1
    const useSingleLayerPushAndShove =
      isSingleLayerFanout &&
      this.config.singleLayerPushAndShove &&
      !this.preparedBuses.some(
        (bus) => bus.exitEdge && bus.preferredExit?.includes("-"),
      )
    if (useSingleLayerPushAndShove) {
      const singleLayerParams = {
        srj: this.routingSrj,
        buses: this.preparedBuses,
        traceWidth: this.config.traceWidth,
        clearance: this.config.clearance,
        borderDistribution: this.config.borderDistribution,
      }
      let singleLayerPlans = routeSingleLayerWithPushAndShove(singleLayerParams)
      if (!singleLayerPlans && this.config.singleLayerAdaptiveExits) {
        this.setInProgressPlans({
          phase: "prepare-single-layer-adaptive-exits",
          plans,
          strategy: routingStrategy,
        })
        yield
        this.setInProgressPlans({
          phase: "route-single-layer-adaptive-exits",
          plans,
          strategy: routingStrategy,
        })
        this.activeAdaptiveVisualization = null
        const adaptiveSolver = this.createWorkSolver(
          "SingleLayerAdaptiveExitSolver",
          routeSingleLayerWithAdaptiveExitsSteps({
            ...singleLayerParams,
            availableBoundaryRegions: resolveAvailableBoundaryRegions(
              this.options.availableCornersAndSides,
            ),
            onProgress: (visualization, adaptiveStats) => {
              this.activeAdaptiveVisualization = visualization
              this.stats = { ...this.stats, ...adaptiveStats }
            },
          }),
          undefined,
          () => this.visualizeAdaptiveRoutingState(),
        )
        singleLayerPlans = (yield {
          type: "subsolver",
          solver: adaptiveSolver,
        }) as FanoutRoutePlan[] | null
      }
      if (singleLayerPlans) {
        plans.push(...singleLayerPlans)
      } else {
        failedBusIds.push(...this.preparedBuses.map((bus) => bus.busId))
      }
      this.setInProgressPlans({
        phase: "route-single-layer",
        plans,
        strategy: routingStrategy,
        unitIndex: 1,
        unitCount: 1,
      })
      yield
    }
    const busesInRoutingOrder = [...this.preparedBuses].sort((a, b) => {
      const aUsesCoordinatedWinding = busUsesCoordinatedWinding(a)
      const bUsesCoordinatedWinding = busUsesCoordinatedWinding(b)
      const aLayerIndex = this.config.layerNames.indexOf(
        busLayerAssignments[a.busId] ?? "",
      )
      const bLayerIndex = this.config.layerNames.indexOf(
        busLayerAssignments[b.busId] ?? "",
      )
      return (
        comparePlaneRoutingPriority(
          a,
          b,
          this.config.allowBlindAndBuriedVias,
        ) ||
        Number(bUsesCoordinatedWinding) - Number(aUsesCoordinatedWinding) ||
        (aUsesCoordinatedWinding && bUsesCoordinatedWinding
          ? bLayerIndex - aLayerIndex
          : 0) ||
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
              : getBusDistanceToBoundary(a) - getBusDistanceToBoundary(b)))
      )
    })

    let mixedTerminationState: MixedTerminationState | null = null
    if (!useSingleLayerPushAndShove && routingStrategy === "default") {
      const denseSolver = this.createWorkSolver(
        "DenseMixedTerminationSolver",
        this.routeDenseThroughAllMixedTerminationSteps({
          busLayerAssignments,
          busesInRoutingOrder,
        }),
        () => {
          const workUnit = Number(this.stats.workUnit ?? 0)
          const workUnitCount = Number(this.stats.workUnitCount ?? 0)
          return workUnitCount > 0 ? workUnit / workUnitCount : 0
        },
      )
      mixedTerminationState = (yield {
        type: "subsolver",
        solver: denseSolver,
      }) as MixedTerminationState | null
    }
    if (
      !mixedTerminationState &&
      !useSingleLayerPushAndShove &&
      routingStrategy === "default" &&
      process.env.FANOUT_DEBUG_DENSE_ONLY === "1"
    ) {
      mixedTerminationState = {
        plans: [],
        failedBusIds: this.preparedBuses.map((bus) => bus.busId),
      }
    }

    if (mixedTerminationState) {
      plans = mixedTerminationState.plans
      failedBusIds = mixedTerminationState.failedBusIds
      this.setInProgressPlans({
        phase: "route-dense-mixed-terminations",
        plans,
        strategy: routingStrategy,
        unitIndex: this.preparedBuses.length,
        unitCount: this.preparedBuses.length,
      })
      yield
    }

    let routingPrefixKey = `${routingStrategy}|`
    let routedBusIndex = 0
    for (const bus of useSingleLayerPushAndShove || mixedTerminationState
      ? []
      : busesInRoutingOrder) {
      routedBusIndex++
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
        this.setInProgressPlans({
          phase: "route-assignment",
          plans,
          strategy: routingStrategy,
          unitIndex: routedBusIndex,
          unitCount: busesInRoutingOrder.length,
          busId: bus.busId,
        })
        yield
        continue
      }
      const currentBusBlockingCounts = new Map<string, number>()
      const busPlans = routeBus({
        srj: this.routingSrj,
        bus,
        targetLayer,
        acceptedPlans: plans,
        layerNames: this.config.layerNames,
        traceWidth: this.config.traceWidth,
        viaDiameter: this.config.viaDiameter,
        viaHoleDiameter: this.config.viaHoleDiameter,
        clearance: this.config.clearance,
        compactBusTracks: this.config.compactBusTracks,
        allowBlindAndBuriedVias: this.config.allowBlindAndBuriedVias,
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
      this.setInProgressPlans({
        phase: "route-assignment",
        plans,
        strategy: routingStrategy,
        unitIndex: routedBusIndex,
        unitCount: busesInRoutingOrder.length,
        busId: bus.busId,
      })
      yield
    }

    let validationIssues: FanoutAttemptSummary["validationIssues"]
    if (plans.length === this.inputSrj.connections.length) {
      const lengthMatching = this.matchCompletePlanLengths(plans)
      if (lengthMatching.plans) {
        plans = lengthMatching.plans
      } else {
        const constrainedBus = lengthMatching.failedBus
        const lengthMatchingIssue: FanoutValidationIssue = {
          code: "bus-length-skew",
          message: `Bus ${constrainedBus.busId} could not satisfy its ${constrainedBus.maxLengthSkew!.toFixed(6)}mm routed-length skew within the fanout boundary`,
          busId: constrainedBus.busId,
        }
        validationIssues = [lengthMatchingIssue]
        this.lengthMatchingFailure ??= lengthMatchingIssue
        plans = []
        failedBusIds = [
          constrainedBus.busId,
          ...this.preparedBuses
            .map((bus) => bus.busId)
            .filter((busId) => busId !== constrainedBus.busId),
        ]
        blockingBusCounts.clear()
      }
    }
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
    this.setInProgressPlans({
      phase: "finalize-assignment-strategy",
      plans,
      strategy: routingStrategy,
    })
    return {
      summary,
      plans,
      blockingBusIds: [...blockingBusCounts.entries()]
        .toSorted(([, firstCount], [, secondCount]) => secondCount - firstCount)
        .map(([busId]) => busId),
      outputSrj,
    }
  }

  private *evaluateAssignmentSteps(
    assignmentIndex: number,
    busLayerAssignments: Readonly<Record<string, string>>,
  ): Generator<FanoutWorkYield, EvaluatedAssignment, unknown> {
    let bestAttempt = yield* this.evaluateAssignmentWithStrategySteps(
      assignmentIndex,
      busLayerAssignments,
      "default",
    )
    if (process.env.FANOUT_DEBUG_DENSE_ONLY === "1") return bestAttempt
    if (
      bestAttempt.summary.routedConnectionCount ===
        this.inputSrj.connections.length &&
      this.getCoordinatedAdditionalViaCount(bestAttempt.plans) === 0
    ) {
      return bestAttempt
    }

    for (const routingStrategy of ["group-by-layer", "deep-first"] as const) {
      const attempt = yield* this.evaluateAssignmentWithStrategySteps(
        assignmentIndex,
        busLayerAssignments,
        routingStrategy,
      )
      if (this.isAttemptBetter(attempt, bestAttempt)) {
        bestAttempt = attempt
      }
      if (
        bestAttempt.summary.routedConnectionCount ===
          this.inputSrj.connections.length &&
        this.getCoordinatedAdditionalViaCount(bestAttempt.plans) === 0
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
  private *evaluateGroupedBeamSteps(
    assignmentIndex: number,
    groupByDirection = false,
  ): Generator<FanoutWorkYield, EvaluatedAssignment | null, unknown> {
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

    const getMaximumViaSpan = (bus: PreparedBus): number => {
      const sourceLayerIndex = this.config.layerNames.indexOf(
        bus.connections[0]?.sourceLayer ?? "",
      )
      const candidateLayers =
        bus.termination.type === "plane"
          ? [bus.termination.layer]
          : (this.escapeLayersByBusId[bus.busId] ?? this.config.escapeLayers)
      return Math.max(
        0,
        ...candidateLayers.map((layer) =>
          Math.abs(this.config.layerNames.indexOf(layer) - sourceLayerIndex),
        ),
      )
    }
    const busesInSearchOrder = [...this.preparedBuses].sort((a, b) => {
      const aUsesCoordinatedWinding = busUsesCoordinatedWinding(a)
      const bUsesCoordinatedWinding = busUsesCoordinatedWinding(b)
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
        comparePlaneRoutingPriority(
          a,
          b,
          this.config.allowBlindAndBuriedVias,
        ) ||
        Number(bUsesCoordinatedWinding) - Number(aUsesCoordinatedWinding) ||
        (aUsesCoordinatedWinding && bUsesCoordinatedWinding
          ? getMaximumViaSpan(b) - getMaximumViaSpan(a)
          : 0) ||
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
          const preferredLayer =
            getCommonExplicitExitTargetLayer(bus) ?? sourceLayer
          return state.assignment[bus.busId] === preferredLayer
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

    let searchedBusIndex = 0
    for (const bus of busesInSearchOrder) {
      searchedBusIndex++
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
        const commonExitTargetLayer = getCommonExplicitExitTargetLayer(bus)
        const preferSourceLayer = busUsesDestinationGuidedTracks(bus)
        const orderedLayers = candidateLayers.toSorted(
          (first, second) =>
            (layerLoads.get(first) ?? 0) - (layerLoads.get(second) ?? 0) ||
            Number(second === commonExitTargetLayer) -
              Number(first === commonExitTargetLayer) ||
            (preferSourceLayer
              ? Number(second === sourceLayer) - Number(first === sourceLayer)
              : Number(first === sourceLayer) -
                Number(second === sourceLayer)) ||
            first.localeCompare(second),
        )

        for (const targetLayer of orderedLayers) {
          const busAlternatives = routeBusAlternatives(
            {
              srj: this.routingSrj,
              bus,
              targetLayer,
              acceptedPlans: state.plans,
              layerNames: this.config.layerNames,
              traceWidth: this.config.traceWidth,
              viaDiameter: this.config.viaDiameter,
              viaHoleDiameter: this.config.viaHoleDiameter,
              clearance: this.config.clearance,
              compactBusTracks: this.config.compactBusTracks,
              allowBlindAndBuriedVias: this.config.allowBlindAndBuriedVias,
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
        const additionalViaDifference =
          this.getCoordinatedAdditionalViaCount(first.plans) -
          this.getCoordinatedAdditionalViaCount(second.plans)
        if (additionalViaDifference !== 0) return additionalViaDifference
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
      this.setInProgressPlans({
        phase: "route-grouped-beam",
        plans: states[0]?.plans ?? [],
        strategy: "grouped-beam",
        unitIndex: searchedBusIndex,
        unitCount: busesInSearchOrder.length,
        busId: bus.busId,
      })
      yield
    }

    let bestState: GroupedBeamState | undefined
    let outputSrj: SimpleRouteJson | undefined
    let bestMatchedScore = Number.POSITIVE_INFINITY
    let bestAdditionalViaCount = Number.POSITIVE_INFINITY
    const getCompleteStateScore = (state: GroupedBeamState): number =>
      state.plans.reduce((total, plan) => total + plan.length, 0) +
      getPlanViaCount(state.plans) * 0.1 +
      assignmentLoadPenalty(
        state.assignment,
        this.preparedBuses,
        this.config.balanceLayerLoadByConnectionCount,
      ) *
        getLayerLoadPenaltyWeight(this.config)
    const hasLengthConstraints = this.preparedBuses.some(
      (bus) => bus.maxLengthSkew !== undefined,
    )
    for (const state of states) {
      if (state.plans.length !== this.inputSrj.connections.length) {
        yield
        continue
      }
      const lengthMatching = this.matchCompletePlanLengths(state.plans)
      if (!lengthMatching.plans) {
        yield
        continue
      }
      const lengthMatchedPlans = lengthMatching.plans
      const candidateOutput = buildOutputSimpleRouteJson({
        inputSrj: this.inputSrj,
        plans: lengthMatchedPlans,
        layerNames: this.config.layerNames,
      })
      if (
        !this.validateCompletePlans(lengthMatchedPlans, candidateOutput).valid
      ) {
        yield
        continue
      }
      const candidateState = { ...state, plans: lengthMatchedPlans }
      const candidateAdditionalViaCount =
        this.getCoordinatedAdditionalViaCount(lengthMatchedPlans)
      const candidateScore = getCompleteStateScore(candidateState)
      if (
        !bestState ||
        candidateAdditionalViaCount < bestAdditionalViaCount ||
        (candidateAdditionalViaCount === bestAdditionalViaCount &&
          candidateScore < bestMatchedScore)
      ) {
        bestState = candidateState
        outputSrj = candidateOutput
        bestMatchedScore = candidateScore
        bestAdditionalViaCount = candidateAdditionalViaCount
      }
      if (!hasLengthConstraints) break
      this.setInProgressPlans({
        phase: "validate-grouped-beam",
        plans: lengthMatchedPlans,
        strategy: "grouped-beam",
      })
      yield
    }
    if (!bestState || !outputSrj) return null
    const score = bestMatchedScore
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

  private *evaluateGroupedBeamAlternativesSteps(
    assignmentIndex: number,
  ): Generator<FanoutWorkYield, EvaluatedAssignment | null, unknown> {
    const primaryAttempt = yield* this.evaluateGroupedBeamSteps(assignmentIndex)
    if (primaryAttempt) return primaryAttempt
    return yield* this.evaluateGroupedBeamSteps(assignmentIndex, true)
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

  private getCoordinatedAdditionalViaCount(
    plans: readonly FanoutRoutePlan[],
  ): number {
    const coordinatedBusIds = new Set(
      this.preparedBuses
        .filter(busUsesCoordinatedWinding)
        .map((bus) => bus.busId),
    )
    return plans.reduce(
      (count, plan) =>
        count +
        (coordinatedBusIds.has(plan.busId)
          ? (plan.additionalVias?.length ?? 0)
          : 0),
      0,
    )
  }

  private isAttemptBetter(
    candidate: AssignmentAttempt,
    current: AssignmentAttempt,
  ): boolean {
    if (
      candidate.summary.routedConnectionCount !==
      current.summary.routedConnectionCount
    ) {
      return (
        candidate.summary.routedConnectionCount >
        current.summary.routedConnectionCount
      )
    }
    if (candidate.summary.routedBusCount !== current.summary.routedBusCount) {
      return candidate.summary.routedBusCount > current.summary.routedBusCount
    }
    const candidateAdditionalVias = this.getCoordinatedAdditionalViaCount(
      candidate.plans,
    )
    const currentAdditionalVias = this.getCoordinatedAdditionalViaCount(
      current.plans,
    )
    if (candidateAdditionalVias !== currentAdditionalVias) {
      return candidateAdditionalVias < currentAdditionalVias
    }
    return candidate.summary.score < current.summary.score
  }

  private hasGloballyViaMinimalBestAttempt(): boolean {
    if (!this.hasCompleteBestAttempt() || !this.bestAttempt) return false
    if (
      this.preparedBuses.length === 0 ||
      !this.preparedBuses.every(busUsesCoordinatedWinding)
    ) {
      return false
    }
    return this.bestAttempt.plans.every(
      (plan) =>
        plan.via !== undefined && (plan.additionalVias?.length ?? 0) === 0,
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

  private commitGroupedBeamAttempt(
    beamAttempt: EvaluatedAssignment | null,
  ): void {
    if (!beamAttempt) {
      if (
        this.hasCompleteBestAttempt() &&
        this.bestAttempt &&
        this.getCoordinatedAdditionalViaCount(this.bestAttempt.plans) === 0
      ) {
        this.completeBestAttemptEndpoints()
        this.solved = true
      }
      return
    }
    this.attempts.push(beamAttempt.summary)
    if (
      !this.bestAttempt ||
      this.isAttemptBetter(beamAttempt, this.bestAttempt)
    ) {
      this.bestAttempt = beamAttempt
    }
    const bestSummary = this.bestAttempt.summary
    this.stats = {
      phase: "complete-grouped-beam",
      assignment:
        bestSummary.assignmentIndex < 0 ? 0 : bestSummary.assignmentIndex + 1,
      assignmentCount: this.config.maxLayerCombinations,
      routedBuses: `${bestSummary.routedBusCount}/${this.preparedBuses.length}`,
      routedConnections: `${bestSummary.routedConnectionCount}/${this.inputSrj.connections.length}`,
      failedBuses: "none",
      bestScore: bestSummary.score,
    }
    if (this.getCoordinatedAdditionalViaCount(this.bestAttempt.plans) === 0) {
      this.completeBestAttemptEndpoints()
      this.solved = true
    }
  }

  private commitAssignmentAttempt(
    assignment: Readonly<Record<string, string>>,
    attempt: EvaluatedAssignment,
  ): void {
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
    if (!this.bestAttempt || this.isAttemptBetter(attempt, this.bestAttempt)) {
      this.bestAttempt = attempt
    }
    this.stats = {
      phase: "complete-assignment",
      assignment: attempt.summary.assignmentIndex + 1,
      assignmentCount: this.config.maxLayerCombinations,
      routedBuses: `${attempt.summary.routedBusCount}/${this.preparedBuses.length}`,
      routedConnections: `${attempt.summary.routedConnectionCount}/${this.inputSrj.connections.length}`,
      failedBuses: attempt.summary.failedBusIds.join(", ") || "none",
      bestScore: this.bestAttempt.summary.score,
    }
    if (
      this.groupedBeamEvaluated &&
      attempt.summary.routedConnectionCount ===
        this.inputSrj.connections.length &&
      this.getCoordinatedAdditionalViaCount(this.bestAttempt.plans) === 0
    ) {
      this.completeBestAttemptEndpoints()
      this.solved = true
    }
  }

  private getNextAssignment(): Readonly<Record<string, string>> | undefined {
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
    return assignment
  }

  private finishWithoutAnotherAssignment(): void {
    if (this.hasCompleteBestAttempt()) {
      this.completeBestAttemptEndpoints()
      this.solved = true
      return
    }
    this.failed = true
    const validationMessage =
      this.lengthMatchingFailure?.message ??
      this.bestAttempt?.summary.validationIssues?.[0]?.message
    this.error = validationMessage
      ? `FanoutSolver: ${validationMessage}`
      : this.bestAttempt
        ? `FanoutSolver: best layer assignment routed ${this.bestAttempt.summary.routedConnectionCount}/${this.inputSrj.connections.length} connections`
        : "FanoutSolver: no layer assignment could be evaluated"
  }

  override _step(): void {
    if (this.activeOperation) {
      this.stepActiveOperation()
      return
    }

    if (!this.routingInitialized) {
      this.startOperation({
        name: "FanoutCandidateLayerSolver",
        generator: this.initializeRoutingSteps(),
        onSolved: () => {},
        getProgress: () =>
          this.nextCandidateLayerBusIndex /
          Math.max(1, this.boundaryBuses.length + 1),
      })
      return
    }

    if (
      this.nextAssignmentIndex > 0 &&
      this.hasGloballyViaMinimalBestAttempt()
    ) {
      this.completeBestAttemptEndpoints()
      this.solved = true
      return
    }
    // Try the deterministic assignment and only its targeted repair queue
    // before paying for the grouped beam. If the beam cannot solve, continue
    // with the broader generated-assignment search below.
    if (this.shouldEvaluateGroupedBeam()) {
      this.groupedBeamEvaluated = true
      this.startOperation({
        name: "FanoutGroupedBeamSolver",
        generator: this.evaluateGroupedBeamAlternativesSteps(-1),
        onSolved: (attempt) => this.commitGroupedBeamAttempt(attempt),
        getProgress: () => {
          const workUnit = Number(this.stats.workUnit ?? 0)
          const workUnitCount = Number(this.stats.workUnitCount ?? 0)
          return workUnitCount > 0 ? workUnit / workUnitCount : 0
        },
      })
      this.stats = { ...this.stats, phase: "prepare-grouped-beam" }
      return
    }

    const assignment = this.getNextAssignment()
    if (!assignment && !this.groupedBeamEvaluated) return
    if (!assignment) {
      this.finishWithoutAnotherAssignment()
      return
    }

    this.startOperation({
      name: "FanoutAssignmentSolver",
      generator: this.evaluateAssignmentSteps(
        this.nextAssignmentIndex,
        assignment,
      ),
      onSolved: (attempt) => this.commitAssignmentAttempt(assignment, attempt),
      getProgress: () => {
        const strategyIndex =
          this.stats.routingStrategy === "group-by-layer"
            ? 1
            : this.stats.routingStrategy === "deep-first"
              ? 2
              : 0
        const workUnit = Number(this.stats.workUnit ?? 0)
        const workUnitCount = Number(this.stats.workUnitCount ?? 0)
        const strategyFraction =
          workUnitCount > 0 ? Math.min(1, workUnit / workUnitCount) : 0
        return (strategyIndex + strategyFraction) / 3
      },
    })
    this.stats = {
      ...this.stats,
      phase: "prepare-assignment",
      assignment: this.nextAssignmentIndex + 1,
      assignmentCount: this.config.maxLayerCombinations,
      routedConnections: `0/${this.inputSrj.connections.length}`,
    }
  }

  computeProgress(): number {
    if (this.solved || this.failed) return 1
    if (!this.routingInitialized) {
      return (
        0.05 *
        (this.nextCandidateLayerBusIndex /
          Math.max(1, this.boundaryBuses.length + 1))
      )
    }
    let activeAssignmentFraction = 0
    if (this.activeSubSolver?.getSolverName() === "FanoutAssignmentSolver") {
      const strategyIndex =
        this.stats.routingStrategy === "group-by-layer"
          ? 1
          : this.stats.routingStrategy === "deep-first"
            ? 2
            : 0
      const workUnit = Number(this.stats.workUnit ?? 0)
      const workUnitCount = Number(this.stats.workUnitCount ?? 0)
      const strategyFraction =
        workUnitCount > 0 ? Math.min(1, workUnit / workUnitCount) : 0
      activeAssignmentFraction = (strategyIndex + strategyFraction) / 3
    }
    return Math.min(
      0.99,
      0.05 +
        0.95 *
          ((this.nextAssignmentIndex + activeAssignmentFraction) /
            this.config.maxLayerCombinations),
    )
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
    const finalSrj = addViaLayerMetadataToSrj({
      srj:
        this.endpointCompletion?.simpleRouteJson ?? this.bestAttempt.outputSrj,
      layerNames: this.config.layerNames,
      allowBlindAndBuriedVias: this.config.allowBlindAndBuriedVias,
    })
    const finalTraceById = new Map(
      (finalSrj.traces ?? []).map((trace) => [trace.pcb_trace_id, trace]),
    )
    return {
      simpleRouteJson: finalSrj,
      fanoutTraces: this.bestAttempt.plans.flatMap((plan) => [
        finalTraceById.get(plan.trace.pcb_trace_id) ?? plan.trace,
        ...(plan.planeEndpointTrace
          ? [
              finalTraceById.get(plan.planeEndpointTrace.pcb_trace_id) ??
                plan.planeEndpointTrace,
            ]
          : []),
      ]),
      completionTraces: (this.endpointCompletion?.traces ?? []).map(
        (trace) => finalTraceById.get(trace.pcb_trace_id) ?? trace,
      ),
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

  getOutputSimpleRouteJson(): SimpleRouteJsonWithFanoutPlanes {
    return this.getOutput().simpleRouteJson
  }

  override visualize(): GraphicsObject {
    return this.activeSubSolver?.visualize() ?? this.visualizeCurrentState()
  }
}
