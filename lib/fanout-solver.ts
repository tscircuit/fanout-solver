import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { addViaLayerMetadataToSrj } from "./add-via-layer-metadata"
import {
  getCornerBandSide,
  getDirectionForExitEdge,
  getExitEdgeForDirection,
} from "./boundary-exit"
import { buildOutputSimpleRouteJson } from "./build-output"
import {
  type CompleteOriginalEndpointsResult,
  completeOriginalEndpoints,
} from "./complete-original-endpoints"
import {
  generateLayerAssignments,
  getCopperLayerNames,
  getLayerAssignmentKey,
  getViaSpanLayers,
} from "./layer-names"
import { matchBusPlanLengths } from "./match-bus-lengths"
import {
  type ComponentDogboneViaPath,
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaPaths,
  matchComponentDogboneViaSiteAlternatives,
  matchComponentDogboneViaSites,
} from "./match-component-dogbone-via-sites"
import {
  connectionsShareElectricalNet,
  obstacleSharesElectricalNet,
} from "./net-identity"
import {
  prepareFanoutBuses,
  resolveAvailableBoundaryRegions,
} from "./prepare-buses"
import {
  fanoutPlansAreClear,
  getPrioritizedSourceTopologyConnectionOrders,
  type RouteBusStaticClearanceCache,
  routeBus,
  routeBusAlternatives,
} from "./route-bus"
import { routeSingleLayerWithAdaptiveExits } from "./route-single-layer-adaptive-exits"
import { routeSingleLayerWithPushAndShove } from "./route-single-layer-push-shove"
import {
  routeViaMinimalWindingAlternatives,
  type ViaMinimalWindingSoftViaCapacityGroup,
} from "./route-via-minimal-winding"
import type {
  AssignmentAttempt,
  Bounds,
  FanoutAttemptSummary,
  FanoutBorderDistribution,
  FanoutRoutePlan,
  FanoutSolverOptions,
  FanoutSolverOutput,
  FanoutValidationIssue,
  Point2D,
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

export function projectPointToBoundaryExitEdge(params: {
  point: { x: number; y: number }
  exitEdge: NonNullable<PreparedBus["exitEdge"]>
  boundary: Bounds
}): { x: number; y: number } {
  const { point, exitEdge, boundary } = params
  switch (exitEdge) {
    case "left":
      return { x: boundary.minX, y: point.y }
    case "right":
      return { x: boundary.maxX, y: point.y }
    case "top":
      return { x: point.x, y: boundary.maxY }
    case "bottom":
      return { x: point.x, y: boundary.minY }
  }
}

export function assignRemappedExitPointsPreservingBusTargetOrder<
  TConnection extends {
    connectionIndex: number
    targetPoint: Point2D
  },
>(params: {
  sourceOrderedConnections: readonly TConnection[]
  groupedBuses: readonly { connections: readonly TConnection[] }[]
  orderedExitPoints: readonly Point2D[]
  tangentAxis: "x" | "y"
}): Map<number, Point2D> {
  const {
    sourceOrderedConnections,
    groupedBuses,
    orderedExitPoints,
    tangentAxis,
  } = params
  if (sourceOrderedConnections.length !== orderedExitPoints.length) {
    throw new Error(
      "FanoutSolver: grouped boundary remap requires one exit point per connection",
    )
  }

  const busIndexByConnectionIndex = new Map<number, number>()
  for (const [busIndex, bus] of groupedBuses.entries()) {
    for (const connection of bus.connections) {
      if (busIndexByConnectionIndex.has(connection.connectionIndex)) {
        throw new Error(
          `FanoutSolver: grouped boundary remap contains duplicate connection index ${connection.connectionIndex}`,
        )
      }
      busIndexByConnectionIndex.set(connection.connectionIndex, busIndex)
    }
  }

  const allocatedExitPointsByBusIndex = groupedBuses.map(() => [] as Point2D[])
  const seenConnectionIndexes = new Set<number>()
  for (const [rank, connection] of sourceOrderedConnections.entries()) {
    const busIndex = busIndexByConnectionIndex.get(connection.connectionIndex)
    if (busIndex === undefined) {
      throw new Error(
        `FanoutSolver: grouped boundary remap is missing connection index ${connection.connectionIndex}`,
      )
    }
    if (seenConnectionIndexes.has(connection.connectionIndex)) {
      throw new Error(
        `FanoutSolver: grouped boundary remap repeats connection index ${connection.connectionIndex}`,
      )
    }
    seenConnectionIndexes.add(connection.connectionIndex)
    allocatedExitPointsByBusIndex[busIndex]!.push(orderedExitPoints[rank]!)
  }

  const exitPointByConnectionIndex = new Map<number, Point2D>()
  for (const [busIndex, bus] of groupedBuses.entries()) {
    const targetOrderedConnections = bus.connections.toSorted(
      (first, second) =>
        first.targetPoint[tangentAxis] - second.targetPoint[tangentAxis] ||
        first.connectionIndex - second.connectionIndex,
    )
    const targetOrderedExitPoints = allocatedExitPointsByBusIndex[
      busIndex
    ]!.toSorted(
      (first, second) =>
        first[tangentAxis] - second[tangentAxis] ||
        first.x - second.x ||
        first.y - second.y,
    )
    if (targetOrderedConnections.length !== targetOrderedExitPoints.length) {
      throw new Error(
        "FanoutSolver: grouped boundary remap must include every bus connection exactly once",
      )
    }
    for (const [rank, connection] of targetOrderedConnections.entries()) {
      exitPointByConnectionIndex.set(
        connection.connectionIndex,
        targetOrderedExitPoints[rank]!,
      )
    }
  }
  return exitPointByConnectionIndex
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
    const commonExitTargetLayer = getCommonExplicitExitTargetLayer(bus)
    const targetLayerConnectionCount = new Map<string, number>()
    const targetTrackSumByLayer = new Map<string, number>()
    for (const connection of bus.connections) {
      const targetLayer = connection.exitTargetPoint?.layer
      if (targetLayer && routableEscapeLayers.includes(targetLayer)) {
        targetLayerConnectionCount.set(
          targetLayer,
          (targetLayerConnectionCount.get(targetLayer) ?? 0) + 1,
        )
        const targetTrack = connection.exitTargetPoint
          ? bus.exitEdge === "left" || bus.exitEdge === "right"
            ? connection.exitTargetPoint.y
            : connection.exitTargetPoint.x
          : undefined
        if (targetTrack !== undefined) {
          targetTrackSumByLayer.set(
            targetLayer,
            (targetTrackSumByLayer.get(targetLayer) ?? 0) + targetTrack,
          )
        }
      }
    }
    const cornerSide = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    const explicitExitTargetLayers = [...targetLayerConnectionCount.keys()]
    const coordinatedWindingHasMixedSourceTargets =
      explicitExitTargetLayers.includes(sourceLayer) &&
      explicitExitTargetLayers.some((layer) => layer !== sourceLayer)
    const coordinatedVerticalWindingHasOnlyNonSourceTargets =
      (bus.exitEdge === "top" || bus.exitEdge === "bottom") &&
      explicitExitTargetLayers.length > 1 &&
      explicitExitTargetLayers.every((layer) => layer !== sourceLayer)
    const coordinatedWindingShouldPreferExplicitTargetLayer =
      busUsesCoordinatedWinding(bus) &&
      (coordinatedWindingHasMixedSourceTargets ||
        coordinatedVerticalWindingHasOnlyNonSourceTargets)
    const preferredExplicitExitTargetLayer =
      coordinatedWindingShouldPreferExplicitTargetLayer
        ? explicitExitTargetLayers
            .filter((layer) => layer !== sourceLayer)
            .toSorted((first, second) => {
              const countDifference =
                targetLayerConnectionCount.get(second)! -
                targetLayerConnectionCount.get(first)!
              if (countDifference !== 0) return countDifference
              // Preserve the established escape-layer choice when explicit
              // target layers have equal support. Letting corner-track means
              // break this tie can replace a via-minimal winding with a much
              // more expensive topology.
              const sourceIndex = escapeLayers.indexOf(sourceLayer)
              const firstIndex = escapeLayers.indexOf(first)
              const secondIndex = escapeLayers.indexOf(second)
              const layerOrderDifference =
                Math.abs(firstIndex - sourceIndex) -
                  Math.abs(secondIndex - sourceIndex) ||
                firstIndex - secondIndex
              if (layerOrderDifference !== 0) return layerOrderDifference
              if (cornerSide) {
                const firstMean =
                  (targetTrackSumByLayer.get(first) ?? 0) /
                  targetLayerConnectionCount.get(first)!
                const secondMean =
                  (targetTrackSumByLayer.get(second) ?? 0) /
                  targetLayerConnectionCount.get(second)!
                const cornerDifference =
                  cornerSide === "minimum"
                    ? firstMean - secondMean
                    : secondMean - firstMean
                if (Math.abs(cornerDifference) > 1e-9) return cornerDifference
              }
              return first.localeCompare(second)
            })[0]
        : undefined
    if (
      commonExitTargetLayer &&
      routableEscapeLayers.includes(commonExitTargetLayer)
    ) {
      assignment[bus.busId] = commonExitTargetLayer
    } else if (preferredExplicitExitTargetLayer) {
      assignment[bus.busId] = preferredExplicitExitTargetLayer
    } else if (
      !busUsesCoordinatedWinding(bus) &&
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
  const initialKey = getLayerAssignmentKey(initialAssignment)
  return [
    initialAssignment,
    ...generatedAssignments.filter(
      (assignment) => getLayerAssignmentKey(assignment) !== initialKey,
    ),
  ].slice(0, maxAssignments)
}

function getDenseMixedTerminationLayerAssignmentPenalty(
  assignment: Readonly<Record<string, string>>,
  buses: readonly PreparedBus[],
): number {
  const boundaryBuses = buses.filter(
    (bus) => bus.termination.type === "boundary",
  )
  let penalty = 0
  for (const bus of boundaryBuses) {
    const assignedLayer = assignment[bus.busId]
    if (!assignedLayer) continue
    // A same-source-layer choice removes the through-via corridor that the
    // dense mixed-termination solver uses to coordinate the whole field.
    penalty +=
      1_000 *
      bus.connections.filter(
        (connection) => connection.sourceLayer === assignedLayer,
      ).length
    if (bus.connections.length <= 2) continue
    // Prefer placing a wide byte lane away from the layer shared by its
    // neighboring clock/strobe/mask trunks. This avoids asking two unrelated
    // windings to occupy the same narrow channel when an explicit alternate
    // exit layer is already available.
    for (const narrowBus of boundaryBuses) {
      if (
        narrowBus === bus ||
        narrowBus.connections.length > 2 ||
        narrowBus.componentId !== bus.componentId ||
        narrowBus.exitEdge !== bus.exitEdge ||
        assignment[narrowBus.busId] !== assignedLayer
      ) {
        continue
      }
      penalty += bus.connections.length * narrowBus.connections.length
    }
  }
  return penalty
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

export interface DenseFixedMapSearchPolicy {
  useExpandedStateSearch: boolean
  useFixedViaWindingOnly: boolean
  useGloballyPackedCornerBandLanes: boolean
  usePathAwareJointPlaneReservation: boolean
  usePlaneCapacityReplay: boolean
}

export function getDenseFixedMapSearchPolicy(params: {
  boundaryBusCount: number
  planeBusCount: number
}): DenseFixedMapSearchPolicy {
  const useCompleteFieldSearch =
    params.boundaryBusCount === 9 && params.planeBusCount > 0
  return {
    useExpandedStateSearch: useCompleteFieldSearch,
    useFixedViaWindingOnly: useCompleteFieldSearch,
    useGloballyPackedCornerBandLanes: useCompleteFieldSearch,
    usePathAwareJointPlaneReservation: useCompleteFieldSearch,
    usePlaneCapacityReplay: useCompleteFieldSearch,
  }
}

export function shouldUseReleasedDenseAdaptivePreflight<
  TBus extends {
    busId: string
    connections: readonly { sourceLayer: string }[]
  },
>(params: {
  boundaryBuses: readonly TBus[]
  planeBusCount: number
  busLayerAssignments: Readonly<Record<string, string>>
}): boolean {
  return (
    params.boundaryBuses.length === 9 &&
    (params.planeBusCount === 0 || params.planeBusCount >= 8) &&
    params.boundaryBuses.every((bus) => {
      const assignedLayer = params.busLayerAssignments[bus.busId]
      return (
        assignedLayer !== undefined &&
        bus.connections.every(
          (connection) => connection.sourceLayer !== assignedLayer,
        )
      )
    })
  )
}

export function runReleasedDenseAdaptivePreflightIfEligible<T>(params: {
  eligible: boolean
  runPreflight: () => T | null
}): T | null {
  return params.eligible ? params.runPreflight() : null
}

export function getBusWithDenseSearchCornerBandOffset<
  TBus extends {
    busId: string
    cornerBandExitLaneOffset?: number
  },
>(params: {
  bus: TBus
  useGloballyPackedCornerBandLanes: boolean
  legacyCornerBandExitLaneOffsetByBusId: ReadonlyMap<string, number | undefined>
}): TBus {
  const {
    bus,
    useGloballyPackedCornerBandLanes,
    legacyCornerBandExitLaneOffsetByBusId,
  } = params
  const cornerBandExitLaneOffset = useGloballyPackedCornerBandLanes
    ? bus.cornerBandExitLaneOffset
    : legacyCornerBandExitLaneOffsetByBusId.get(bus.busId)
  return cornerBandExitLaneOffset === bus.cornerBandExitLaneOffset
    ? bus
    : { ...bus, cornerBandExitLaneOffset }
}

export type DenseDogboneCompletionAssignment =
  | { kind: "direct"; viaPoints: Map<number, Point2D> }
  | { kind: "path"; viaPaths: Map<number, ComponentDogboneViaPath> }

/**
 * Preserve the released direct dogbone search as the cheap first choice, then
 * expand source escape paths only when every direct site assignment is
 * blocked. Dense complete fields can otherwise eagerly construct channel
 * candidates for every plane drop even though the direct map is complete.
 */
export function matchDenseDogboneCompletionDirectFirst(params: {
  matchDirect: () => Map<number, Point2D> | null
  matchPaths?: () => Map<number, ComponentDogboneViaPath> | null
}): DenseDogboneCompletionAssignment | null {
  const viaPoints = params.matchDirect()
  if (viaPoints) return { kind: "direct", viaPoints }
  const viaPaths = params.matchPaths?.()
  return viaPaths ? { kind: "path", viaPaths } : null
}

export function getDenseBoundaryPlanGeometryKey(
  plans: readonly FanoutRoutePlan[],
): string {
  return JSON.stringify(
    plans
      .map((plan) => ({
        connectionIndex: plan.connectionIndex,
        via: plan.via ? [plan.via.center.x, plan.via.center.y] : null,
        segments: plan.segments.map((segment) => [
          segment.layer,
          segment.width,
          segment.start.x,
          segment.start.y,
          segment.end.x,
          segment.end.y,
        ]),
      }))
      .toSorted(
        (first, second) => first.connectionIndex - second.connectionIndex,
      ),
  )
}

export function matchDenseDogboneCompletionDirectFirstCached(params: {
  geometryKey: string
  completionByGeometry: Map<string, DenseDogboneCompletionAssignment>
  matchDirect: () => Map<number, Point2D> | null
  matchPaths?: () => Map<number, ComponentDogboneViaPath> | null
}): DenseDogboneCompletionAssignment | null {
  if (params.completionByGeometry.has(params.geometryKey)) {
    return params.completionByGeometry.get(params.geometryKey) ?? null
  }
  const completion = matchDenseDogboneCompletionDirectFirst(params)
  if (completion) {
    params.completionByGeometry.set(params.geometryKey, completion)
  }
  return completion
}

export function selectDenseLengthPlansThenMatchDogbones<TPlan>(params: {
  selectPlans: () => readonly TPlan[] | null
  matchFinalCompletion: (
    plans: readonly TPlan[],
  ) => DenseDogboneCompletionAssignment | null
}): {
  plans: readonly TPlan[]
  completion: DenseDogboneCompletionAssignment | null
} | null {
  const plans = params.selectPlans()
  if (!plans) return null
  return {
    plans,
    completion: params.matchFinalCompletion(plans),
  }
}

export function getDenseCompletionSourceEscapePaths(
  completion: DenseDogboneCompletionAssignment | null,
): Map<number, readonly Point2D[]> | undefined {
  return completion?.kind === "path"
    ? new Map(
        [...completion.viaPaths].map(([connectionIndex, assignment]) => [
          connectionIndex,
          assignment.path,
        ]),
      )
    : undefined
}

/**
 * Dogbone points and source paths are clipped to the supplied bounds. An
 * obstacle farther away than this conservative rotated-rectangle envelope
 * cannot affect either their via or trace clearance.
 */
export function obstacleMayAffectBoundedDogboneField(params: {
  obstacle: Obstacle
  bounds: Bounds
  clearanceMargin: number
}): boolean {
  const { obstacle, bounds, clearanceMargin } = params
  const conservativeRadius = Math.hypot(obstacle.width, obstacle.height) / 2
  return !(
    obstacle.center.x + conservativeRadius < bounds.minX - clearanceMargin ||
    obstacle.center.x - conservativeRadius > bounds.maxX + clearanceMargin ||
    obstacle.center.y + conservativeRadius < bounds.minY - clearanceMargin ||
    obstacle.center.y - conservativeRadius > bounds.maxY + clearanceMargin
  )
}

export function runLegacyFirstDenseRootProbe<T>(params: {
  probeLegacy: () => T
  legacyIsUsable: (probe: T) => boolean
  probeExpanded: () => T
}): { probe: T; usedExpandedSearch: boolean } {
  const legacyProbe = params.probeLegacy()
  if (params.legacyIsUsable(legacyProbe)) {
    return { probe: legacyProbe, usedExpandedSearch: false }
  }
  return { probe: params.probeExpanded(), usedExpandedSearch: true }
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

function isDenseSingletonEmbeddedInWideBus(params: {
  singletonBus: DenseSourceFieldBus
  singletonTargetLayer: string
  wideBuses: readonly DenseSourceFieldBus[]
  requireSingleLayerWideBus: boolean
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
      (params.requireSingleLayerWideBus
        ? wideLayers.length !== 1
        : wideLayers.length < 2) ||
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

export function isDenseSingletonEmbeddedInMultiLayerWideBus(params: {
  singletonBus: DenseSourceFieldBus
  singletonTargetLayer: string
  wideBuses: readonly DenseSourceFieldBus[]
}): boolean {
  return isDenseSingletonEmbeddedInWideBus({
    ...params,
    requireSingleLayerWideBus: false,
  })
}

export function isDenseSingletonEmbeddedInSingleLayerWideBus(params: {
  singletonBus: DenseSourceFieldBus
  singletonTargetLayer: string
  wideBuses: readonly DenseSourceFieldBus[]
}): boolean {
  return isDenseSingletonEmbeddedInWideBus({
    ...params,
    requireSingleLayerWideBus: true,
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

export function shouldSearchReleasedDenseBoundaryRouteTopologies(params: {
  boundaryBusCount: number
  planeBusCount: number
  connectionCount: number
  rawSkew: number
  maximumSkew: number
}): boolean {
  return (
    shouldSearchAdditionalBoundaryRouteTopologies(params) ||
    (params.boundaryBusCount === 9 &&
      params.planeBusCount === 0 &&
      params.connectionCount > 2 &&
      params.rawSkew > params.maximumSkew + 1e-9)
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

interface DenseCornerTargetLaneBus {
  busId: string
  componentId?: string
  exitEdge?: PreparedBus["exitEdge"]
  preferredExit?: PreparedBus["preferredExit"]
  connections: readonly {
    connectionIndex?: number
    exitTargetPoint?: { x: number; y: number }
  }[]
}

const getBoundaryTangentTargetTrack = (
  bus: DenseCornerTargetLaneBus,
  connectionIndex: number,
): number | undefined => {
  const target = bus.connections[connectionIndex]?.exitTargetPoint
  if (!target || !bus.exitEdge) return undefined
  return bus.exitEdge === "left" || bus.exitEdge === "right"
    ? target.y
    : target.x
}

export function isDenseCornerSingletonTargetLaneInwardOfPairs(params: {
  singletonBus: DenseCornerTargetLaneBus
  pairBuses: readonly DenseCornerTargetLaneBus[]
  assignedLayerByBusId: ReadonlyMap<string, string>
  routePitch: number
}): boolean {
  const { singletonBus, pairBuses, assignedLayerByBusId, routePitch } = params
  if (singletonBus.connections.length !== 1 || !singletonBus.exitEdge) {
    return false
  }
  const cornerSide = getCornerBandSide(
    singletonBus.exitEdge,
    singletonBus.preferredExit,
  )
  const singletonTargetTrack = getBoundaryTangentTargetTrack(singletonBus, 0)
  const assignedLayer = assignedLayerByBusId.get(singletonBus.busId)
  if (
    !cornerSide ||
    singletonTargetTrack === undefined ||
    !assignedLayer ||
    !Number.isFinite(routePitch) ||
    routePitch <= 0
  ) {
    return false
  }

  const pairTargetTracks = pairBuses.flatMap((pairBus) => {
    if (
      pairBus.connections.length !== 2 ||
      pairBus.exitEdge !== singletonBus.exitEdge ||
      getCornerBandSide(pairBus.exitEdge, pairBus.preferredExit) !==
        cornerSide ||
      assignedLayerByBusId.get(pairBus.busId) !== assignedLayer
    ) {
      return []
    }
    const tracks = pairBus.connections.map((_, connectionIndex) =>
      getBoundaryTangentTargetTrack(pairBus, connectionIndex),
    )
    return tracks.every((track): track is number => track !== undefined)
      ? tracks
      : []
  })
  if (pairTargetTracks.length === 0) return false

  return cornerSide === "maximum"
    ? singletonTargetTrack <= Math.min(...pairTargetTracks) - routePitch + 1e-9
    : singletonTargetTrack >= Math.max(...pairTargetTracks) + routePitch - 1e-9
}

export function isDenseSingletonTargetLaneAdjacentToPairs(params: {
  singletonBus: DenseCornerTargetLaneBus
  pairBuses: readonly DenseCornerTargetLaneBus[]
  assignedLayerByBusId: ReadonlyMap<string, string>
  routePitch: number
}): boolean {
  const { singletonBus, pairBuses, assignedLayerByBusId, routePitch } = params
  if (
    singletonBus.connections.length !== 1 ||
    !singletonBus.exitEdge ||
    !singletonBus.componentId ||
    getCornerBandSide(singletonBus.exitEdge, singletonBus.preferredExit) ||
    !Number.isFinite(routePitch) ||
    routePitch <= 0
  ) {
    return false
  }
  const singletonTargetTrack = getBoundaryTangentTargetTrack(singletonBus, 0)
  const assignedLayer = assignedLayerByBusId.get(singletonBus.busId)
  if (singletonTargetTrack === undefined || !assignedLayer) return false

  return pairBuses.some((pairBus) => {
    if (
      pairBus.connections.length !== 2 ||
      pairBus.componentId !== singletonBus.componentId ||
      pairBus.exitEdge !== singletonBus.exitEdge ||
      getCornerBandSide(pairBus.exitEdge, pairBus.preferredExit) ||
      assignedLayerByBusId.get(pairBus.busId) !== assignedLayer
    ) {
      return false
    }
    const pairTargetTracks = pairBus.connections.map((_, connectionIndex) =>
      getBoundaryTangentTargetTrack(pairBus, connectionIndex),
    )
    if (
      !pairTargetTracks.every((track): track is number => track !== undefined)
    ) {
      return false
    }
    const minimumPairTrack = Math.min(...pairTargetTracks)
    const maximumPairTrack = Math.max(...pairTargetTracks)
    if (
      singletonTargetTrack >= minimumPairTrack &&
      singletonTargetTrack <= maximumPairTrack
    ) {
      return false
    }
    const distanceToPairInterval = Math.min(
      Math.abs(singletonTargetTrack - minimumPairTrack),
      Math.abs(singletonTargetTrack - maximumPairTrack),
    )
    return (
      distanceToPairInterval >= routePitch - 1e-9 &&
      distanceToPairInterval <= 2 * routePitch + 1e-9
    )
  })
}

function isDenseSingletonTargetLaneOrderedWithPairs(params: {
  singletonBus: DenseCornerTargetLaneBus
  pairBuses: readonly DenseCornerTargetLaneBus[]
  assignedLayerByBusId: ReadonlyMap<string, string>
  routePitch: number
}): boolean {
  return (
    isDenseCornerSingletonTargetLaneInwardOfPairs(params) ||
    isDenseSingletonTargetLaneAdjacentToPairs(params)
  )
}

export function getDenseCornerTargetLaneOffsets(params: {
  buses: readonly DenseCornerTargetLaneBus[]
  assignedLayerByBusId: ReadonlyMap<string, string>
}): ReadonlyMap<string, number> {
  const { buses, assignedLayerByBusId } = params
  const busesByCornerBand = new Map<string, DenseCornerTargetLaneBus[]>()
  for (const bus of buses) {
    const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    if (!bus.exitEdge || !side) continue
    const assignedLayer = assignedLayerByBusId.get(bus.busId)
    if (!assignedLayer) continue
    const key = `${bus.exitEdge}:${side}:${assignedLayer}`
    const bandBuses = busesByCornerBand.get(key) ?? []
    bandBuses.push(bus)
    busesByCornerBand.set(key, bandBuses)
  }

  const laneOffsetByBusId = new Map<string, number>()
  for (const bandBuses of busesByCornerBand.values()) {
    const orderedConnections = bandBuses
      .flatMap((bus) =>
        bus.connections.map((_, connectionIndex) => ({
          bus,
          connectionIndex,
          targetTrack: getBoundaryTangentTargetTrack(bus, connectionIndex),
        })),
      )
      .toSorted(
        (first, second) =>
          (first.targetTrack ?? 0) - (second.targetTrack ?? 0) ||
          first.bus.busId.localeCompare(second.bus.busId) ||
          first.connectionIndex - second.connectionIndex,
      )
    if (
      orderedConnections.some(({ targetTrack }) => targetTrack === undefined) ||
      orderedConnections.some(
        ({ targetTrack }, index) =>
          index > 0 &&
          Math.abs(
            targetTrack! - orderedConnections[index - 1]!.targetTrack!,
          ) <= 1e-9,
      )
    ) {
      continue
    }

    let bandIsContiguousByBus = true
    for (const bus of bandBuses) {
      const ranks = orderedConnections.flatMap((entry, rank) =>
        entry.bus === bus ? [rank] : [],
      )
      const firstRank = ranks[0]
      if (
        firstRank === undefined ||
        ranks.some((rank, index) => rank !== firstRank + index)
      ) {
        bandIsContiguousByBus = false
        break
      }
    }
    if (!bandIsContiguousByBus) continue
    for (const bus of bandBuses) {
      laneOffsetByBusId.set(
        bus.busId,
        orderedConnections.findIndex((entry) => entry.bus === bus),
      )
    }
  }
  return laneOffsetByBusId
}

/** Packs every layer group sharing a physical corner band into disjoint slots. */
export function getDenseCornerBandLaneOffsets(params: {
  buses: readonly DenseCornerTargetLaneBus[]
  assignedLayerByBusId: ReadonlyMap<string, string>
}): ReadonlyMap<string, number> {
  const { buses, assignedLayerByBusId } = params
  const busesByBand = new Map<string, DenseCornerTargetLaneBus[]>()
  for (const bus of buses) {
    const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    if (!bus.exitEdge || !side || !assignedLayerByBusId.has(bus.busId)) continue
    const key = `${bus.exitEdge}:${side}`
    const bandBuses = busesByBand.get(key) ?? []
    bandBuses.push(bus)
    busesByBand.set(key, bandBuses)
  }

  const offsets = new Map<string, number>()
  for (const bandBuses of busesByBand.values()) {
    const bandSide = getCornerBandSide(
      bandBuses[0]?.exitEdge,
      bandBuses[0]?.preferredExit,
    )
    const entries = bandBuses.map((bus) => {
      const tracks = bus.connections.flatMap((_, index) => {
        const track = getBoundaryTangentTargetTrack(bus, index)
        return track === undefined ? [] : [track]
      })
      return {
        bus,
        layer: assignedLayerByBusId.get(bus.busId)!,
        width: bus.connections.length,
        targetTrack:
          (tracks.length > 0
            ? tracks.reduce((sum, track) => sum + track, 0) / tracks.length
            : 0) * (bandSide === "maximum" ? -1 : 1),
        firstConnectionIndex: Math.min(
          ...bus.connections.map(
            (connection) => connection.connectionIndex ?? Number.MAX_VALUE,
          ),
        ),
      }
    })
    const targetOrderedEntries = entries.toSorted(
      (first, second) =>
        first.targetTrack - second.targetTrack ||
        first.firstConnectionIndex - second.firstConnectionIndex,
    )
    const widestEntry = entries.toSorted(
      (first, second) =>
        second.width - first.width ||
        first.targetTrack - second.targetTrack ||
        first.firstConnectionIndex - second.firstConnectionIndex,
    )[0]
    if (!widestEntry) continue
    const totalWidth = entries.reduce((sum, entry) => sum + entry.width, 0)
    const idealWidestStart = Math.round((totalWidth - widestEntry.width) / 2)
    const entriesByLayer = new Map<string, typeof entries>()
    for (const entry of targetOrderedEntries) {
      const layerEntries = entriesByLayer.get(entry.layer) ?? []
      layerEntries.push(entry)
      entriesByLayer.set(entry.layer, layerEntries)
    }
    const prefixChoicesByLayer = [...entriesByLayer.values()].map(
      (layerEntries) => {
        const widestIndex = layerEntries.indexOf(widestEntry)
        const prefixCounts =
          widestIndex >= 0
            ? [widestIndex]
            : Array.from(
                { length: layerEntries.length + 1 },
                (_, index) => index,
              )
        return prefixCounts.map((prefixCount) => ({
          entries: layerEntries.slice(0, prefixCount),
          width: layerEntries
            .slice(0, prefixCount)
            .reduce((sum, entry) => sum + entry.width, 0),
        }))
      },
    )
    const leadingChoices: Array<{
      entries: typeof entries
      width: number
    }> = []
    const enumerateLeadingChoices = (
      layerIndex: number,
      selectedEntries: typeof entries,
      width: number,
    ): void => {
      if (layerIndex === prefixChoicesByLayer.length) {
        leadingChoices.push({ entries: selectedEntries, width })
        return
      }
      for (const choice of prefixChoicesByLayer[layerIndex]!) {
        enumerateLeadingChoices(
          layerIndex + 1,
          [...selectedEntries, ...choice.entries],
          width + choice.width,
        )
      }
    }
    enumerateLeadingChoices(0, [], 0)
    const leadingChoice = leadingChoices.toSorted(
      (first, second) =>
        Math.abs(first.width - idealWidestStart) -
          Math.abs(second.width - idealWidestStart) ||
        second.width - first.width,
    )[0]!
    const widestStart = leadingChoice.width
    offsets.set(widestEntry.bus.busId, widestStart)
    const leadingEntries = new Set(leadingChoice.entries)
    let leadingCursor = 0
    let trailingCursor = widestStart + widestEntry.width
    for (const entry of targetOrderedEntries) {
      if (entry === widestEntry) continue
      if (leadingEntries.has(entry)) {
        offsets.set(entry.bus.busId, leadingCursor)
        leadingCursor += entry.width
      } else {
        offsets.set(entry.bus.busId, trailingCursor)
        trailingCursor += entry.width
      }
    }
  }
  return offsets
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

export type DenseBoundaryRoutingOrderKind =
  | "interleaved"
  | "wide-first"
  | "constraint-first"

export interface DenseBoundaryRoutingOrderCandidate<T> {
  kind: DenseBoundaryRoutingOrderKind
  buses: readonly T[]
}

export function getReleasedDenseProvisionalSingletonBuses<T>(params: {
  singletonDeferralCandidates: readonly T[]
  leadingWideSingletonBuses: readonly T[]
  laneInwardSingletonBuses: ReadonlySet<T>
}): T[] {
  const leadingWideSingletonBusSet = new Set(params.leadingWideSingletonBuses)
  return params.singletonDeferralCandidates.filter(
    (bus) =>
      !leadingWideSingletonBusSet.has(bus) &&
      !params.laneInwardSingletonBuses.has(bus),
  )
}

export function buildReleasedDenseBoundaryRoutingOrder<
  T extends { connections: readonly unknown[] },
>(params: {
  boundaryBuses: readonly T[]
  leadingWideSingletonBuses: readonly T[]
  earlyInwardSingletonBuses: readonly T[]
  laneOrderSingletonBuses: readonly T[]
  targetOrderedPairBuses: ReadonlySet<T>
}): T[] {
  const leadingWideSingletonBusSet = new Set(params.leadingWideSingletonBuses)
  const earlyInwardSingletonBusSet = new Set(params.earlyInwardSingletonBuses)
  const laneOrderSingletonBusSet = new Set(params.laneOrderSingletonBuses)
  return [
    ...params.leadingWideSingletonBuses,
    ...params.boundaryBuses.filter(
      (bus) =>
        !leadingWideSingletonBusSet.has(bus) && bus.connections.length > 2,
    ),
    ...params.earlyInwardSingletonBuses,
    ...params.boundaryBuses.filter(
      (bus) =>
        !leadingWideSingletonBusSet.has(bus) &&
        bus.connections.length <= 2 &&
        !earlyInwardSingletonBusSet.has(bus) &&
        !laneOrderSingletonBusSet.has(bus) &&
        !params.targetOrderedPairBuses.has(bus),
    ),
    ...params.laneOrderSingletonBuses,
    ...params.boundaryBuses.filter((bus) =>
      params.targetOrderedPairBuses.has(bus),
    ),
  ]
}

export function normalizeDenseCenteredAdjacentLaneBundleOrder<T>(params: {
  busesInRoutingOrder: readonly T[]
  adjacentSingletonBuses: readonly T[]
  getComparablePairBuses: (singletonBus: T) => readonly T[]
  getRelatedPairBuses: (singletonBus: T) => readonly T[]
  getTargetTracks: (bus: T) => readonly number[]
}): T[] {
  const originalIndexByBus = new Map(
    params.busesInRoutingOrder.map((bus, index) => [bus, index]),
  )
  const claimedRelatedPairBuses = new Set<T>()
  const bundleBlocks = params.adjacentSingletonBuses.flatMap((singletonBus) => {
    const relatedPairBuses = params
      .getRelatedPairBuses(singletonBus)
      .filter(
        (bus) =>
          originalIndexByBus.has(bus) && !claimedRelatedPairBuses.has(bus),
      )
    if (
      !originalIndexByBus.has(singletonBus) ||
      relatedPairBuses.length === 0
    ) {
      return []
    }
    for (const pairBus of relatedPairBuses) {
      claimedRelatedPairBuses.add(pairBus)
    }
    return [[singletonBus, ...relatedPairBuses]]
  })
  if (bundleBlocks.length === 0) return [...params.busesInRoutingOrder]

  const comparablePairBuses = new Set(
    params.adjacentSingletonBuses.flatMap((singletonBus) =>
      params
        .getComparablePairBuses(singletonBus)
        .filter((bus) => originalIndexByBus.has(bus)),
    ),
  )
  const ordinaryPairBlocks = [...comparablePairBuses]
    .filter((bus) => !claimedRelatedPairBuses.has(bus))
    .map((bus) => [bus])
  const affectedBuses = new Set([...ordinaryPairBlocks, ...bundleBlocks].flat())
  const insertionIndex = Math.min(
    ...[...affectedBuses].map((bus) => originalIndexByBus.get(bus)!),
  )
  const orderedBlocks = [...ordinaryPairBlocks, ...bundleBlocks].toSorted(
    (first, second) => {
      const firstTracks = first.flatMap(params.getTargetTracks)
      const secondTracks = second.flatMap(params.getTargetTracks)
      const firstMinimumTrack = Math.min(...firstTracks)
      const secondMinimumTrack = Math.min(...secondTracks)
      return (
        firstMinimumTrack - secondMinimumTrack ||
        Math.min(...first.map((bus) => originalIndexByBus.get(bus)!)) -
          Math.min(...second.map((bus) => originalIndexByBus.get(bus)!))
      )
    },
  )
  const orderedAffectedBuses = orderedBlocks.flat()
  const result = params.busesInRoutingOrder.filter(
    (bus) => !affectedBuses.has(bus),
  )
  result.splice(insertionIndex, 0, ...orderedAffectedBuses)
  return result
}

export function buildDenseBoundaryRoutingOrderCandidates<T>(params: {
  allBoundaryBuses: readonly T[]
  minimumCornerWideBuses: readonly T[]
  maximumCornerWideBuses: readonly T[]
  unbandedWideBuses: readonly T[]
  pairBusesLeadingWideBuses: readonly T[]
  leadingWideSingletonBuses: readonly T[]
  unembeddedPairBuses: readonly T[]
  remainingEmbeddedPairBuses: readonly T[]
  remainingNarrowBoundaryBuses: readonly T[]
  getTrailingPairFollowers: (wideBus: T) => readonly T[]
  getProvisionalFollowers: (wideBus: T) => readonly T[]
  getBusKey: (bus: T) => string
}): Array<DenseBoundaryRoutingOrderCandidate<T>> {
  const {
    allBoundaryBuses,
    minimumCornerWideBuses,
    maximumCornerWideBuses,
    unbandedWideBuses,
    pairBusesLeadingWideBuses,
    leadingWideSingletonBuses,
    unembeddedPairBuses,
    remainingEmbeddedPairBuses,
    remainingNarrowBoundaryBuses,
    getTrailingPairFollowers,
    getProvisionalFollowers,
    getBusKey,
  } = params
  const getFollowers = (wideBus: T) => [
    ...getTrailingPairFollowers(wideBus),
    ...getProvisionalFollowers(wideBus),
  ]
  const withFollowers = (wideBuses: readonly T[]) =>
    wideBuses.flatMap((wideBus) => [wideBus, ...getFollowers(wideBus)])
  const commonTail = [
    ...unembeddedPairBuses,
    ...remainingEmbeddedPairBuses,
    ...remainingNarrowBoundaryBuses,
  ]
  const constraintFirstWideBuses = [
    ...unbandedWideBuses,
    ...maximumCornerWideBuses,
    ...minimumCornerWideBuses,
  ]
  const candidates: Array<DenseBoundaryRoutingOrderCandidate<T>> = [
    {
      kind: "interleaved",
      buses: [
        ...minimumCornerWideBuses,
        ...minimumCornerWideBuses.flatMap(getTrailingPairFollowers),
        ...pairBusesLeadingWideBuses,
        ...minimumCornerWideBuses.flatMap(getProvisionalFollowers),
        ...leadingWideSingletonBuses,
        ...withFollowers(unbandedWideBuses),
        ...withFollowers(maximumCornerWideBuses),
        ...commonTail,
      ],
    },
    {
      kind: "wide-first",
      buses: [
        ...minimumCornerWideBuses,
        ...maximumCornerWideBuses,
        ...unbandedWideBuses,
        ...[
          ...minimumCornerWideBuses,
          ...maximumCornerWideBuses,
          ...unbandedWideBuses,
        ].flatMap(getFollowers),
        ...pairBusesLeadingWideBuses,
        ...leadingWideSingletonBuses,
        ...commonTail,
      ],
    },
    {
      kind: "constraint-first",
      buses: [
        ...unbandedWideBuses,
        ...leadingWideSingletonBuses,
        ...maximumCornerWideBuses,
        ...minimumCornerWideBuses,
        ...unembeddedPairBuses,
        ...pairBusesLeadingWideBuses,
        ...remainingEmbeddedPairBuses,
        ...remainingNarrowBoundaryBuses,
        ...constraintFirstWideBuses.flatMap((wideBus) => [
          ...getProvisionalFollowers(wideBus),
          ...getTrailingPairFollowers(wideBus),
        ]),
      ],
    },
  ]
  const expectedKeys = allBoundaryBuses.map(getBusKey)
  const expectedKeySet = new Set(expectedKeys)
  if (expectedKeySet.size !== expectedKeys.length) {
    throw new Error("Dense boundary buses must have unique keys")
  }
  const seenOrderKeys = new Set<string>()
  return candidates.filter((candidate) => {
    const keys = candidate.buses.map(getBusKey)
    if (
      keys.length !== expectedKeys.length ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !expectedKeySet.has(key))
    ) {
      throw new Error(
        `Dense boundary routing order ${candidate.kind} must contain every boundary bus exactly once`,
      )
    }
    const orderKey = keys.join("\u0000")
    if (seenOrderKeys.has(orderKey)) return false
    seenOrderKeys.add(orderKey)
    return true
  })
}

export function routeIdentityTerminalsBeforeRemaps<
  TTerminal,
  TAlternative,
>(params: {
  identityTerminals: TTerminal[]
  identityBudget: { remaining: number }
  createRemapBudget: (identityConsumedStates: number) => {
    remaining: number
  }
  getRemappedTerminalCandidates: () => TTerminal[][]
  route: (
    terminals: TTerminal[],
    expandedStateBudget: { remaining: number },
  ) => TAlternative[]
}): {
  selectedTerminals: TTerminal[]
  alternatives: TAlternative[]
  consumedStates: number
} {
  const initialIdentityBudget = params.identityBudget.remaining
  let selectedTerminals = params.identityTerminals
  let alternatives = params.route(
    params.identityTerminals,
    params.identityBudget,
  )
  const identityConsumedStates =
    initialIdentityBudget - params.identityBudget.remaining
  if (alternatives.length > 0) {
    return {
      selectedTerminals,
      alternatives,
      consumedStates: identityConsumedStates,
    }
  }

  const remapBudget = params.createRemapBudget(identityConsumedStates)
  const initialRemapBudget = remapBudget.remaining
  for (const terminals of params.getRemappedTerminalCandidates()) {
    const remappedAlternatives = params.route(terminals, remapBudget)
    if (remappedAlternatives.length > 0) {
      selectedTerminals = terminals
      alternatives = remappedAlternatives
      break
    }
    if (remapBudget.remaining <= 0) break
  }
  return {
    selectedTerminals,
    alternatives,
    consumedStates:
      identityConsumedStates + initialRemapBudget - remapBudget.remaining,
  }
}

export function shouldUseDenseBoundaryFirstFallback(params: {
  totalBoundaryConnectionCount: number
  planeBusCount: number
  boundaryExitEdges: readonly PreparedBus["exitEdge"][]
  rootProbes: readonly { failed: boolean; planCount: number }[]
}): boolean {
  if (
    params.totalBoundaryConnectionCount < 24 ||
    params.planeBusCount === 0 ||
    params.rootProbes.length === 0 ||
    !params.rootProbes.every((probe) => probe.failed)
  ) {
    return false
  }
  return (
    params.rootProbes.every((probe) => probe.planCount <= 1) ||
    (params.boundaryExitEdges.length > 0 &&
      params.boundaryExitEdges.every((edge) => edge === "top"))
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
  readonly layerAssignments: Array<Readonly<Record<string, string>>>
  readonly config: ResolvedFanoutConfig
  private readonly routingSrj: SimpleRouteJson
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
              srj: this.routingSrj,
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
    const prioritizedAssignments = prioritizeLayerAssignment({
      initialAssignment: createInitialLayerAssignment({
        buses: this.preparedBuses,
        escapeLayers: this.config.escapeLayers,
        escapeLayersByBusId,
      }),
      generatedAssignments,
      maxAssignments: this.config.maxLayerCombinations,
    })
    const boundaryBuses = this.preparedBuses.filter(
      (bus) => bus.termination.type === "boundary",
    )
    const hasPlaneBuses = this.preparedBuses.some(
      (bus) => bus.termination.type === "plane",
    )
    this.layerAssignments =
      boundaryBuses.length >= 9 &&
      hasPlaneBuses &&
      boundaryBuses.every((bus) => bus.exitEdge === "left")
        ? prioritizedAssignments.toSorted(
            (first, second) =>
              getDenseMixedTerminationLayerAssignmentPenalty(
                first,
                boundaryBuses,
              ) -
              getDenseMixedTerminationLayerAssignmentPenalty(
                second,
                boundaryBuses,
              ),
          )
        : prioritizedAssignments
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
   * legal dogbone channel for nearby boundary or plane pads. Match those
   * dogbone sites jointly, search a tiny number of whole-bus boundary
   * alternatives, then fill any remaining plane dogbones. This is
   * intentionally bounded independently of the number of plane drops so dense
   * power fields cannot explode the general beam search.
   */
  private routeDenseThroughAllMixedTerminations(params: {
    busLayerAssignments: Readonly<Record<string, string>>
    busesInRoutingOrder: readonly PreparedBus[]
    boundaryFirstFallback?: boolean
  }): MixedTerminationState | null {
    if (this.config.allowBlindAndBuriedVias) return null
    const boundaryFirstFallback = params.boundaryFirstFallback ?? false
    const denseExpandedStateBudget = {
      remaining: 32_000_000,
      exhausted: false,
    }
    let bestDensePartialPlans: FanoutRoutePlan[] = []

    const unsortedBoundaryBuses = params.busesInRoutingOrder.filter(
      (bus) => bus.termination.type === "boundary",
    )
    const useJointBoundaryViaReservation =
      unsortedBoundaryBuses.length === params.busesInRoutingOrder.length ||
      shouldUseJointBoundaryViaReservation(
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
    const boundaryBuses = unsortedBoundaryBuses.toSorted((first, second) => {
      // Reserve the dense escape field for the widest buses first. Small
      // control groups can usually route around their copper, while routing
      // a two-line corner bus first can consume a critical channel needed by
      // an eight-line winding bus and force the expensive fallback search.
      if (useJointBoundaryViaReservation) {
        const connectionCountDifference =
          second.connections.length - first.connections.length
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
        Number(Boolean(getCornerBandSide(first.exitEdge, first.preferredExit)))
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
    })
    // Preserve the caller/input order for the dense singleton fill. The
    // general routing sort is useful for heterogeneous buses, but ordering a
    // regular BGA power field by obstacle depth creates artificial local
    // dead-ends and needlessly triggers the widened boundary beam. The local
    // rip-up/retry below handles the genuinely constrained drops.
    const planeBuses = this.preparedBuses.filter(
      (bus) => bus.termination.type === "plane",
    )
    const planeConnectionIndexes = new Set(
      planeBuses.flatMap((bus) =>
        bus.connections.map((connection) => connection.connectionIndex),
      ),
    )
    if (
      boundaryBuses.length === 0 ||
      boundaryBuses.length > 9 ||
      (planeBuses.length > 0 && planeBuses.length < 8) ||
      boundaryBuses.some((bus) => !busUsesCoordinatedWinding(bus)) ||
      planeBuses.some((bus) => bus.connections.length !== 1) ||
      boundaryBuses.length + planeBuses.length !==
        params.busesInRoutingOrder.length
    ) {
      return null
    }
    const fixedMapSearchPolicy = getDenseFixedMapSearchPolicy({
      boundaryBusCount: boundaryBuses.length,
      planeBusCount: planeBuses.length,
    })
    const useReleasedDenseAdaptivePreflight =
      shouldUseReleasedDenseAdaptivePreflight({
        boundaryBuses,
        planeBusCount: planeBuses.length,
        busLayerAssignments: params.busLayerAssignments,
      })
    const releasedAdaptivePreflightSearchBudget = {
      remaining: 8_000_000,
      exhausted: false,
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
    const routePitch = Math.max(
      this.config.traceWidth + this.config.clearance,
      this.config.viaDiameter + this.config.clearance,
    )
    const assignedLayerByBusId = new Map(
      boundaryBuses.flatMap((bus) => {
        const assignedLayer = params.busLayerAssignments[bus.busId]
        return assignedLayer ? [[bus.busId, assignedLayer] as const] : []
      }),
    )
    const pairBuses = boundaryBuses.filter(
      (bus) => bus.connections.length === 2,
    )
    const cornerLaneInwardSingletonBusSet = new Set(
      boundaryBuses.filter(
        (bus) =>
          boundaryBuses.length === 9 &&
          isDenseCornerSingletonTargetLaneInwardOfPairs({
            singletonBus: bus,
            pairBuses,
            assignedLayerByBusId,
            routePitch,
          }),
      ),
    )
    const centeredAdjacentSingletonBusSet = new Set(
      boundaryBuses.filter(
        (bus) =>
          boundaryBuses.length === 9 &&
          isDenseSingletonTargetLaneAdjacentToPairs({
            singletonBus: bus,
            pairBuses,
            assignedLayerByBusId,
            routePitch,
          }),
      ),
    )
    const laneInwardSingletonBusSet = new Set([
      ...cornerLaneInwardSingletonBusSet,
      ...centeredAdjacentSingletonBusSet,
    ])
    const legacyCornerBandExitLaneOffsetByBusId = new Map<
      string,
      number | undefined
    >(boundaryBuses.map((bus) => [bus.busId, undefined]))
    if (laneInwardSingletonBusSet.size > 0) {
      const targetLaneOffsetByBusId = getDenseCornerTargetLaneOffsets({
        buses: boundaryBuses,
        assignedLayerByBusId,
      })
      const targetOrderedBandLayerKeys = new Set(
        [...laneInwardSingletonBusSet].flatMap((bus) => {
          const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
          const assignedLayer = assignedLayerByBusId.get(bus.busId)
          return bus.exitEdge && side && assignedLayer
            ? [`${bus.exitEdge}:${side}:${assignedLayer}`]
            : []
        }),
      )
      for (const bus of boundaryBuses) {
        const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
        const assignedLayer = assignedLayerByBusId.get(bus.busId)
        const bandLayerKey =
          bus.exitEdge && side && assignedLayer
            ? `${bus.exitEdge}:${side}:${assignedLayer}`
            : undefined
        legacyCornerBandExitLaneOffsetByBusId.set(
          bus.busId,
          bandLayerKey && targetOrderedBandLayerKeys.has(bandLayerKey)
            ? targetLaneOffsetByBusId.get(bus.busId)
            : undefined,
        )
      }
    }
    if (fixedMapSearchPolicy.useGloballyPackedCornerBandLanes) {
      const packedCornerBandLaneOffsets = getDenseCornerBandLaneOffsets({
        buses: boundaryBuses,
        assignedLayerByBusId,
      })
      for (const bus of boundaryBuses) {
        bus.cornerBandExitLaneOffset = packedCornerBandLaneOffsets.get(
          bus.busId,
        )
      }
    } else {
      for (const bus of boundaryBuses) {
        bus.cornerBandExitLaneOffset =
          legacyCornerBandExitLaneOffsetByBusId.get(bus.busId)
      }
    }
    const preferredBoundaryPerpendicularSideByBusId = new Map(
      boundaryBuses.map((bus) => [bus.busId, 1 as const]),
    )
    const preferBoundaryOutwardByBusId = new Map(
      boundaryBuses.map((bus) => [
        bus.busId,
        useGeometryAwareSingletonOutwardPreference &&
        bus.connections.length === 1 &&
        getCornerBandSide(bus.exitEdge, bus.preferredExit)
          ? getDenseSingletonBoundaryGeometry(bus).targetProjection > 0
          : getExitEdgeForDirection(bus.direction) !== bus.exitEdge,
      ]),
    )
    const canShareCopper = (
      firstConnectionIndex: number,
      secondConnectionIndex: number,
    ): boolean => {
      if (
        !this.config.allowSameNetMerges &&
        !(
          planeConnectionIndexes.has(firstConnectionIndex) &&
          planeConnectionIndexes.has(secondConnectionIndex)
        )
      ) {
        return false
      }
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
    const releasedCanShareCopper = this.config.allowSameNetMerges
      ? canShareCopper
      : () => false
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
    const legacyLeadingWideSingletonBuses =
      boundaryBuses.length === 9
        ? singletonDeferralCandidates.filter((singletonBus) => {
            const singletonTargetLayer =
              params.busLayerAssignments[singletonBus.busId]
            return Boolean(
              !laneInwardSingletonBusSet.has(singletonBus) &&
                singletonTargetLayer &&
                isDenseSingletonEmbeddedInMultiLayerWideBus({
                  singletonBus,
                  singletonTargetLayer,
                  wideBuses: boundaryBuses,
                }),
            )
          })
        : []
    const releasedPreferBoundaryOutwardByBusId = new Map(
      preferBoundaryOutwardByBusId,
    )
    for (const bus of legacyLeadingWideSingletonBuses) {
      releasedPreferBoundaryOutwardByBusId.set(bus.busId, true)
    }
    const releasedViaProvisionalSingletonBusSet = new Set(
      getReleasedDenseProvisionalSingletonBuses({
        singletonDeferralCandidates,
        leadingWideSingletonBuses: legacyLeadingWideSingletonBuses,
        laneInwardSingletonBuses: laneInwardSingletonBusSet,
      }),
    )
    const releasedInitiallyMatchedBoundaryBuses = boundaryBuses.filter(
      (bus) => !releasedViaProvisionalSingletonBusSet.has(bus),
    )
    const releasedLeadingLaneCountByWideCornerBand = new Map<string, number>()
    if (
      boundaryBuses.length === 9 &&
      legacyLeadingWideSingletonBuses.length > 0
    ) {
      for (const bus of legacyLeadingWideSingletonBuses) {
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
        releasedLeadingLaneCountByWideCornerBand.set(
          bandKey,
          (releasedLeadingLaneCountByWideCornerBand.get(bandKey) ?? 0) +
            bus.connections.length,
        )
      }
    }
    const getReleasedCornerBandTargetTrackOffset = (
      bus: PreparedBus,
    ): number => {
      const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
      if (!bus.exitEdge || !side) return 0
      const leadingLaneCount =
        releasedLeadingLaneCountByWideCornerBand.get(
          `${bus.exitEdge}:${side}`,
        ) ?? 0
      return getDenseLeadingCornerBandTargetTrackOffset({
        leadingLaneCount,
        traceWidth: this.config.traceWidth,
        viaDiameter: this.config.viaDiameter,
        clearance: this.config.clearance,
      })
    }
    const singleLayerEmbeddedSingletonBuses = singletonBoundaryBuses.filter(
      (singletonBus) => {
        const singletonTargetLayer =
          params.busLayerAssignments[singletonBus.busId]
        return Boolean(
          singletonTargetLayer &&
            isDenseSingletonEmbeddedInSingleLayerWideBus({
              singletonBus,
              singletonTargetLayer,
              wideBuses: boundaryBuses,
            }),
        )
      },
    )
    const leadingWideSingletonBuses = [
      ...legacyLeadingWideSingletonBuses,
      ...singleLayerEmbeddedSingletonBuses.filter(
        (bus) =>
          !legacyLeadingWideSingletonBuses.includes(bus) &&
          !laneInwardSingletonBusSet.has(bus),
      ),
    ]
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
    const viaProvisionalSingletonBusSet = new Set(
      singletonDeferralCandidates.filter(
        (bus) =>
          !leadingWideSingletonBuses.includes(bus) &&
          !laneInwardSingletonBusSet.has(bus),
      ),
    )
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
      (bus) => !viaProvisionalSingletonBusSet.has(bus),
    )
    const maximumDenseDogboneSearchStates = 100_000
    const jointMatchingRules = {
      viaDiameter: this.config.viaDiameter,
      viaHoleDiameter: this.config.viaHoleDiameter,
      traceWidth: this.config.traceWidth,
      clearance: this.config.clearance,
      maximumSearchStates: maximumDenseDogboneSearchStates,
      preferredBoundaryPerpendicularSideByBusId,
      preferBoundaryOutwardByBusId,
      canShareCopper,
    }
    const releasedJointMatchingRules = {
      ...jointMatchingRules,
      preferBoundaryOutwardByBusId: releasedPreferBoundaryOutwardByBusId,
      canShareCopper: releasedCanShareCopper,
      expandedStateBudget: releasedAdaptivePreflightSearchBudget,
    }
    const allJointMatchedBuses = [
      ...planeBuses,
      ...initiallyMatchedBoundaryBuses,
    ]
    const releasedAllJointMatchedBuses = [
      ...planeBuses,
      ...releasedInitiallyMatchedBoundaryBuses,
    ]
    const boundedDogboneBlockingObstacles = this.routingSrj.obstacles.filter(
      (obstacle) =>
        obstacleMayAffectBoundedDogboneField({
          obstacle,
          bounds: this.routingSrj.bounds,
          clearanceMargin:
            Math.max(this.config.viaDiameter / 2, this.config.traceWidth / 2) +
            this.config.clearance,
        }),
    )
    const allBoundaryConnectionIndexes = new Set(
      boundaryBuses.flatMap((bus) =>
        bus.connections.map((connection) => connection.connectionIndex),
      ),
    )
    const matchCompleteDogboneMapAroundBoundaryPlans = (params: {
      plans: readonly FanoutRoutePlan[]
      boundaryViaPoints: ReadonlyMap<number, { x: number; y: number }>
      preferredViaPoints?: ReadonlyMap<number, { x: number; y: number }>
    }): Map<number, { x: number; y: number }> | null => {
      const routedBoundaryConnectionIndexes = new Set(
        params.plans.flatMap((plan) =>
          plan.termination.type === "boundary" ? [plan.connectionIndex] : [],
        ),
      )
      const fixedBoundaryViaPoints = new Map(
        [...params.boundaryViaPoints].filter(
          ([connectionIndex]) =>
            allBoundaryConnectionIndexes.has(connectionIndex) &&
            routedBoundaryConnectionIndexes.has(connectionIndex),
        ),
      )
      return matchComponentDogboneViaSites([...planeBuses, ...boundaryBuses], {
        ...jointMatchingRules,
        fixedViaPointsByConnectionIndex: fixedBoundaryViaPoints,
        preferredViaPointsByConnectionIndex: params.preferredViaPoints,
        blockingSegments: params.plans.flatMap((plan) =>
          plan.segments.map((segment) => ({
            connectionIndex: plan.connectionIndex,
            segment,
          })),
        ),
      })
    }
    const matchCompleteDogbonePathsAroundBoundaryPlans = (params: {
      plans: readonly FanoutRoutePlan[]
      boundaryViaPoints: ReadonlyMap<number, { x: number; y: number }>
      preferredViaPoints?: ReadonlyMap<number, { x: number; y: number }>
      preferredViaPaths?: ReadonlyMap<number, ComponentDogboneViaPath>
      fixedViaPaths?: ReadonlyMap<number, ComponentDogboneViaPath>
      useReleasedMatchingRules?: boolean
    }): Map<number, ComponentDogboneViaPath> | null => {
      const boundaryPlans = params.plans.filter(
        (plan) => plan.termination.type === "boundary",
      )
      const fixedBoundaryViaPoints = new Map(
        boundaryPlans.flatMap((plan) => {
          const point =
            plan.via?.center ??
            params.boundaryViaPoints.get(plan.connectionIndex)
          return point ? [[plan.connectionIndex, point] as const] : []
        }),
      )
      if (fixedBoundaryViaPoints.size !== allBoundaryConnectionIndexes.size) {
        return null
      }
      const pointsMatch = (
        first: { x: number; y: number },
        second: { x: number; y: number },
      ): boolean => Math.hypot(first.x - second.x, first.y - second.y) <= 1e-9
      const fixedBoundaryViaPaths = new Map<number, ComponentDogboneViaPath>()
      for (const plan of boundaryPlans) {
        const point = fixedBoundaryViaPoints.get(plan.connectionIndex)
        if (!point) continue
        const path = [{ x: plan.sourcePoint.x, y: plan.sourcePoint.y }]
        let currentPoint = path[0]!
        for (const segment of plan.segments) {
          if (
            segment.layer !== plan.sourceLayer ||
            !pointsMatch(segment.start, currentPoint)
          ) {
            break
          }
          path.push({ x: segment.end.x, y: segment.end.y })
          currentPoint = segment.end
          if (pointsMatch(currentPoint, point)) break
        }
        if (!pointsMatch(path.at(-1)!, point)) {
          return null
        }
        fixedBoundaryViaPaths.set(plan.connectionIndex, {
          point: { x: point.x, y: point.y },
          path,
        })
      }
      const fixedViaPaths = params.fixedViaPaths
        ? new Map([...params.fixedViaPaths, ...fixedBoundaryViaPaths])
        : fixedBoundaryViaPaths
      const fixedViaPoints = params.fixedViaPaths
        ? new Map([
            ...[...params.fixedViaPaths].map(
              ([connectionIndex, assignment]) =>
                [connectionIndex, assignment.point] as const,
            ),
            ...fixedBoundaryViaPoints,
          ])
        : fixedBoundaryViaPoints
      return matchComponentDogboneViaPaths([...planeBuses, ...boundaryBuses], {
        ...(params.useReleasedMatchingRules
          ? releasedJointMatchingRules
          : jointMatchingRules),
        canShareCopper,
        holeToHoleClearance:
          (
            this.routingSrj as SimpleRouteJson & {
              minViaHoleEdgeToViaHoleEdgeClearance?: number
            }
          ).minViaHoleEdgeToViaHoleEdgeClearance ?? this.config.clearance,
        fixedViaPointsByConnectionIndex: fixedViaPoints,
        fixedViaPathsByConnectionIndex: fixedViaPaths,
        preferredViaPointsByConnectionIndex: params.preferredViaPoints,
        preferredViaPathsByConnectionIndex: params.preferredViaPaths,
        blockingSegments: params.plans.flatMap((plan) =>
          plan.segments.map((segment) => ({
            connectionIndex: plan.connectionIndex,
            segment,
          })),
        ),
        blockingObstacles: boundedDogboneBlockingObstacles,
        obstacleCanBeIgnored: (connectionIndex, obstacle) => {
          const connectionName = connectionNameByIndex.get(connectionIndex)
          return Boolean(
            connectionName &&
              obstacleSharesElectricalNet(
                this.routingSrj,
                obstacle,
                connectionName,
              ),
          )
        },
        planePathOptions: {
          bounds: this.routingSrj.bounds,
          channelConnectionIndexes: planeConnectionIndexes,
          initialChannelRing: 5,
          maximumChannelRing: 5,
          maximumChannelCandidatesPerConnection: 12,
        },
      })
    }
    const getRoutedBoundaryViaPoints = (
      plans: readonly FanoutRoutePlan[],
      fallbackViaPoints: ReadonlyMap<number, { x: number; y: number }>,
    ): Map<number, { x: number; y: number }> =>
      new Map(
        plans.flatMap((plan) => {
          if (plan.termination.type !== "boundary") return []
          const point =
            plan.via?.center ?? fallbackViaPoints.get(plan.connectionIndex)
          return point ? [[plan.connectionIndex, point] as const] : []
        }),
      )
    const getPlaneConnectionsWithoutCandidate = (
      plans: readonly FanoutRoutePlan[],
    ): number[] => {
      const candidateConnectionIndexes = new Set(
        getComponentDogboneViaSiteCandidates(planeBuses, {
          ...jointMatchingRules,
          blockingSegments: plans.flatMap((plan) =>
            plan.segments.map((segment) => ({
              connectionIndex: plan.connectionIndex,
              segment,
            })),
          ),
        }).map((candidate) => candidate.connectionIndex),
      )
      return planeBuses.flatMap((bus) =>
        bus.connections.flatMap((connection) =>
          candidateConnectionIndexes.has(connection.connectionIndex)
            ? []
            : [connection.connectionIndex],
        ),
      )
    }
    const getPlaneCapacityGroups = (
      connectionIndexes: readonly number[],
      blockingPlans: readonly FanoutRoutePlan[],
    ): ViaMinimalWindingSoftViaCapacityGroup[] => {
      const requestedConnectionIndexes = new Set(connectionIndexes)
      const pointsByConnectionIndex = new Map<
        number,
        Array<{ x: number; y: number }>
      >()
      for (const candidate of getComponentDogboneViaSiteCandidates(planeBuses, {
        ...jointMatchingRules,
        blockingSegments: blockingPlans.flatMap((plan) =>
          plan.segments.map((segment) => ({
            connectionIndex: plan.connectionIndex,
            segment,
          })),
        ),
      })) {
        if (!requestedConnectionIndexes.has(candidate.connectionIndex)) continue
        const points =
          pointsByConnectionIndex.get(candidate.connectionIndex) ?? []
        if (
          !points.some(
            (point) =>
              Math.abs(point.x - candidate.point.x) <= 1e-9 &&
              Math.abs(point.y - candidate.point.y) <= 1e-9,
          )
        ) {
          points.push(candidate.point)
        }
        pointsByConnectionIndex.set(candidate.connectionIndex, points)
      }
      return connectionIndexes.flatMap((connectionIndex) => {
        const points = pointsByConnectionIndex.get(connectionIndex) ?? []
        return points.length > 0 ? [{ connectionIndex, points }] : []
      })
    }
    const maximumSoftPlaneCapacityGroupCount = 8
    const maximumSoftPlaneCapacityPointCount = 32
    const getNewlyBlockedPlaneCapacityGroups = (params: {
      acceptedPlans: readonly FanoutRoutePlan[]
      candidatePlans: readonly FanoutRoutePlan[]
    }): ViaMinimalWindingSoftViaCapacityGroup[] | null => {
      const unavailableBefore = new Set(
        getPlaneConnectionsWithoutCandidate(params.acceptedPlans),
      )
      const newlyUnavailable = getPlaneConnectionsWithoutCandidate([
        ...params.acceptedPlans,
        ...params.candidatePlans,
      ]).filter((connectionIndex) => !unavailableBefore.has(connectionIndex))
      if (newlyUnavailable.length === 0) return []
      if (newlyUnavailable.length > maximumSoftPlaneCapacityGroupCount) {
        return null
      }
      const groups = getPlaneCapacityGroups(
        newlyUnavailable,
        params.acceptedPlans,
      )
      if (
        groups.length !== newlyUnavailable.length ||
        groups.reduce((count, group) => count + group.points.length, 0) >
          maximumSoftPlaneCapacityPointCount
      ) {
        return null
      }
      return groups
    }
    const boundaryConnectionIndexes = new Set(
      initiallyMatchedBoundaryBuses.flatMap((bus) =>
        bus.connections.map((connection) => connection.connectionIndex),
      ),
    )
    const getBoundarySignature = (
      points: ReadonlyMap<number, { x: number; y: number }>,
    ) =>
      JSON.stringify(
        [...points.entries()]
          .filter(([connectionIndex]) =>
            boundaryConnectionIndexes.has(connectionIndex),
          )
          .toSorted(([first], [second]) => first - second),
      )
    const legacyJointViaPoints = useJointBoundaryViaReservation
      ? matchComponentDogboneViaSites(allJointMatchedBuses, jointMatchingRules)
      : null
    const releasedJointViaPoints =
      useReleasedDenseAdaptivePreflight && useJointBoundaryViaReservation
        ? matchComponentDogboneViaSites(
            releasedAllJointMatchedBuses,
            releasedJointMatchingRules,
          )
        : null
    const jointViaPointAlternatives = legacyJointViaPoints
      ? [legacyJointViaPoints]
      : []
    let jointViaPoints = jointViaPointAlternatives[0] ?? null
    const seedViaPoints =
      jointViaPoints ??
      matchComponentDogboneViaSites([...planeBuses, boundaryBuses[0]!], {
        viaDiameter: this.config.viaDiameter,
        viaHoleDiameter: this.config.viaHoleDiameter,
        traceWidth: this.config.traceWidth,
        clearance: this.config.clearance,
        maximumSearchStates: 20_000,
        preferredBoundaryPerpendicularSideByBusId,
        preferBoundaryOutwardByBusId,
        canShareCopper,
      })
    const releasedSeedViaPoints = useReleasedDenseAdaptivePreflight
      ? (releasedJointViaPoints ??
        matchComponentDogboneViaSites([...planeBuses, boundaryBuses[0]!], {
          ...releasedJointMatchingRules,
          maximumSearchStates: 20_000,
        }))
      : null
    if (seedViaPoints) {
      // In a nine-bus field, pair windings can fence off a fixed corner
      // singleton whose target lies well inward of its source. Route that
      // singleton after the wide buses have established their channels but
      // before the pairs consume the remaining narrow corridor. If a
      // singleton's downstream lane belongs inward of same-layer pairs,
      // reserve all of those target-ordered corner lanes up front, route
      // unrelated narrow buses first, then route the singleton before its
      // related pairs. This preserves the interconnect winding without making
      // the singleton block an unrelated centered pair.
      const earlyInwardSingletonBuses =
        boundaryBuses.length === 9
          ? boundaryBuses.filter((bus) => {
              if (
                bus.connections.length !== 1 ||
                leadingWideSingletonBuses.includes(bus) ||
                viaProvisionalSingletonBusSet.has(bus)
              ) {
                return false
              }
              const geometry = getDenseSingletonBoundaryGeometry(bus)
              return (
                geometry.isCorner && geometry.targetProjection < -routePitch
              )
            })
          : []
      const laneOrderSingletonBuses = boundaryBuses.filter(
        (bus) =>
          laneInwardSingletonBusSet.has(bus) &&
          !leadingWideSingletonBuses.includes(bus) &&
          !viaProvisionalSingletonBusSet.has(bus) &&
          !earlyInwardSingletonBuses.includes(bus),
      )
      const targetOrderedPairBusSet = new Set(
        pairBuses.filter((pairBus) =>
          laneOrderSingletonBuses.some((singletonBus) =>
            isDenseSingletonTargetLaneOrderedWithPairs({
              singletonBus,
              pairBuses: [pairBus],
              assignedLayerByBusId,
              routePitch,
            }),
          ),
        ),
      )
      const releasedEarlyInwardSingletonBuses =
        boundaryBuses.length === 9
          ? boundaryBuses.filter((bus) => {
              if (
                bus.connections.length !== 1 ||
                legacyLeadingWideSingletonBuses.includes(bus) ||
                releasedViaProvisionalSingletonBusSet.has(bus)
              ) {
                return false
              }
              const geometry = getDenseSingletonBoundaryGeometry(bus)
              return (
                geometry.isCorner && geometry.targetProjection < -routePitch
              )
            })
          : []
      const releasedLaneOrderSingletonBuses = boundaryBuses.filter(
        (bus) =>
          laneInwardSingletonBusSet.has(bus) &&
          !legacyLeadingWideSingletonBuses.includes(bus) &&
          !releasedViaProvisionalSingletonBusSet.has(bus) &&
          !releasedEarlyInwardSingletonBuses.includes(bus),
      )
      const releasedTargetOrderedPairBusSet = new Set(
        pairBuses.filter((pairBus) =>
          releasedLaneOrderSingletonBuses.some((singletonBus) =>
            isDenseSingletonTargetLaneOrderedWithPairs({
              singletonBus,
              pairBuses: [pairBus],
              assignedLayerByBusId,
              routePitch,
            }),
          ),
        ),
      )
      const releasedLegacyBoundaryBusesInRoutingOrder =
        buildReleasedDenseBoundaryRoutingOrder({
          boundaryBuses,
          leadingWideSingletonBuses: legacyLeadingWideSingletonBuses,
          earlyInwardSingletonBuses: releasedEarlyInwardSingletonBuses,
          laneOrderSingletonBuses: releasedLaneOrderSingletonBuses,
          targetOrderedPairBuses: releasedTargetOrderedPairBusSet,
        })
      const getBoundaryTargetTracks = (bus: PreparedBus): number[] =>
        bus.connections.flatMap((_, connectionIndex) => {
          const track = getBoundaryTangentTargetTrack(bus, connectionIndex)
          return track === undefined ? [] : [track]
        })
      const releasedDenseBoundaryBusesInRoutingOrder =
        normalizeDenseCenteredAdjacentLaneBundleOrder({
          busesInRoutingOrder: releasedLegacyBoundaryBusesInRoutingOrder,
          adjacentSingletonBuses: releasedLaneOrderSingletonBuses.filter(
            (bus) => centeredAdjacentSingletonBusSet.has(bus),
          ),
          getComparablePairBuses: (singletonBus) =>
            pairBuses.filter(
              (pairBus) =>
                pairBus.componentId === singletonBus.componentId &&
                pairBus.exitEdge === singletonBus.exitEdge &&
                assignedLayerByBusId.get(pairBus.busId) ===
                  assignedLayerByBusId.get(singletonBus.busId) &&
                getBoundaryTargetTracks(pairBus).length === 2,
            ),
          getRelatedPairBuses: (singletonBus) =>
            pairBuses.filter((pairBus) =>
              isDenseSingletonTargetLaneAdjacentToPairs({
                singletonBus,
                pairBuses: [pairBus],
                assignedLayerByBusId,
                routePitch,
              }),
            ),
          getTargetTracks: getBoundaryTargetTracks,
        })
      const orderedWideBoundaryBuses = boundaryBuses
        .filter(
          (bus) =>
            !leadingWideSingletonBuses.includes(bus) &&
            bus.connections.length > 2,
        )
        .toSorted((first, second) => {
          const getBandPriority = (bus: PreparedBus) => {
            const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
            return side === "minimum" ? 0 : side === "maximum" ? 1 : 2
          }
          return getBandPriority(first) - getBandPriority(second)
        })
      const orderedNarrowBoundaryBuses = [
        ...earlyInwardSingletonBuses,
        ...boundaryBuses.filter(
          (bus) =>
            !leadingWideSingletonBuses.includes(bus) &&
            bus.connections.length <= 2 &&
            !earlyInwardSingletonBuses.includes(bus) &&
            !laneOrderSingletonBuses.includes(bus) &&
            !targetOrderedPairBusSet.has(bus),
        ),
        ...laneOrderSingletonBuses,
        ...boundaryBuses.filter((bus) => targetOrderedPairBusSet.has(bus)),
      ].toSorted((first, second) => {
        const getTargetProjection = (bus: PreparedBus) => {
          const projectionAxis =
            bus.exitEdge === "left" || bus.exitEdge === "right" ? "y" : "x"
          return (
            bus.connections.reduce((sum, connection) => {
              const point = connection.exitTargetPoint ?? connection.targetPoint
              return sum + point[projectionAxis]
            }, 0) / bus.connections.length
          )
        }
        return getTargetProjection(first) - getTargetProjection(second)
      })
      const busSourceIsInsideWideBus = (
        candidateBus: PreparedBus,
        wideBus: PreparedBus,
      ) => {
        const wideSourceBounds = wideBus.connections.reduce(
          (bounds, connection) => ({
            minX: Math.min(bounds.minX, connection.sourcePoint.x),
            maxX: Math.max(bounds.maxX, connection.sourcePoint.x),
            minY: Math.min(bounds.minY, connection.sourcePoint.y),
            maxY: Math.max(bounds.maxY, connection.sourcePoint.y),
          }),
          {
            minX: Number.POSITIVE_INFINITY,
            maxX: Number.NEGATIVE_INFINITY,
            minY: Number.POSITIVE_INFINITY,
            maxY: Number.NEGATIVE_INFINITY,
          },
        )
        return candidateBus.connections.every(
          (connection) =>
            connection.sourcePoint.x >= wideSourceBounds.minX - 1e-9 &&
            connection.sourcePoint.x <= wideSourceBounds.maxX + 1e-9 &&
            connection.sourcePoint.y >= wideSourceBounds.minY - 1e-9 &&
            connection.sourcePoint.y <= wideSourceBounds.maxY + 1e-9,
        )
      }
      const pairBusesEmbeddedInWideBuses = pairBuses.filter((pairBus) =>
        orderedWideBoundaryBuses.some((wideBus) =>
          busSourceIsInsideWideBus(pairBus, wideBus),
        ),
      )
      const pairBusesLeadingWideBuses = pairBusesEmbeddedInWideBuses.filter(
        (pairBus) =>
          orderedWideBoundaryBuses.some(
            (wideBus) =>
              (params.busLayerAssignments[pairBus.busId] ===
                params.busLayerAssignments[wideBus.busId] ||
                getCornerBandSide(wideBus.exitEdge, wideBus.preferredExit) ===
                  "maximum") &&
              busSourceIsInsideWideBus(pairBus, wideBus),
          ),
      )
      const provisionalWideOwnerByBus = new Map(
        orderedNarrowBoundaryBuses.flatMap((bus) => {
          if (!viaProvisionalSingletonBusSet.has(bus)) return []
          const owner = orderedWideBoundaryBuses.find((wideBus) =>
            busSourceIsInsideWideBus(bus, wideBus),
          )
          return owner ? ([[bus, owner]] as const) : []
        }),
      )
      const trailingPairWideOwnerByBus = new Map(
        pairBusesEmbeddedInWideBuses.flatMap((bus) => {
          if (pairBusesLeadingWideBuses.includes(bus)) return []
          const owner = orderedWideBoundaryBuses.find((wideBus) =>
            busSourceIsInsideWideBus(bus, wideBus),
          )
          return owner ? ([[bus, owner]] as const) : []
        }),
      )
      const getTrailingPairFollowers = (wideBus: PreparedBus) =>
        pairBusesEmbeddedInWideBuses.filter(
          (bus) => trailingPairWideOwnerByBus.get(bus) === wideBus,
        )
      const getProvisionalFollowers = (wideBus: PreparedBus) =>
        orderedNarrowBoundaryBuses.filter(
          (bus) => provisionalWideOwnerByBus.get(bus) === wideBus,
        )
      const trailingPairBusSet = new Set(
        [...trailingPairWideOwnerByBus.entries()]
          .filter(
            ([, owner]) =>
              getCornerBandSide(owner.exitEdge, owner.preferredExit) ===
              "maximum",
          )
          .map(([bus]) => bus),
      )
      const fixedReservationBoundaryBuses =
        initiallyMatchedBoundaryBuses.filter(
          (bus) => !trailingPairBusSet.has(bus),
        )
      const minimumCornerWideBuses = orderedWideBoundaryBuses.filter(
        (bus) =>
          getCornerBandSide(bus.exitEdge, bus.preferredExit) === "minimum",
      )
      const maximumCornerWideBuses = orderedWideBoundaryBuses.filter(
        (bus) =>
          getCornerBandSide(bus.exitEdge, bus.preferredExit) === "maximum",
      )
      const unbandedWideBuses = orderedWideBoundaryBuses.filter(
        (bus) => !getCornerBandSide(bus.exitEdge, bus.preferredExit),
      )
      const unembeddedPairBuses = pairBuses.filter(
        (bus) => !pairBusesEmbeddedInWideBuses.includes(bus),
      )
      const remainingEmbeddedPairBuses = pairBusesEmbeddedInWideBuses.filter(
        (bus) =>
          !pairBusesLeadingWideBuses.includes(bus) &&
          !trailingPairWideOwnerByBus.has(bus),
      )
      const remainingNarrowBoundaryBuses = orderedNarrowBoundaryBuses.filter(
        (bus) =>
          !pairBusesEmbeddedInWideBuses.includes(bus) &&
          !unembeddedPairBuses.includes(bus) &&
          !provisionalWideOwnerByBus.has(bus),
      )
      const denseBoundaryRoutingOrders =
        buildDenseBoundaryRoutingOrderCandidates({
          allBoundaryBuses: boundaryBuses,
          minimumCornerWideBuses,
          maximumCornerWideBuses,
          unbandedWideBuses,
          pairBusesLeadingWideBuses,
          leadingWideSingletonBuses,
          unembeddedPairBuses,
          remainingEmbeddedPairBuses,
          remainingNarrowBoundaryBuses,
          getTrailingPairFollowers,
          getProvisionalFollowers,
          getBusKey: (bus) => bus.busId,
        })
      const legacyInterleavedRoutingOrder =
        denseBoundaryRoutingOrders.find(
          (routingOrder) => routingOrder.kind === "interleaved",
        ) ?? denseBoundaryRoutingOrders[0]!
      let selectedDenseBoundaryRoutingOrder = boundaryFirstFallback
        ? legacyInterleavedRoutingOrder
        : denseBoundaryRoutingOrders[0]!
      const remainingBoundaryBusesCanBeCompletedAsNarrowBundle = (
        plans: readonly FanoutRoutePlan[],
      ): boolean => {
        const routedBusIds = new Set(plans.map((plan) => plan.busId))
        const remainingBuses = boundaryBuses.filter(
          (bus) => !routedBusIds.has(bus.busId),
        )
        if (remainingBuses.length === 0) return true
        return remainingBuses.some((seedBus) => {
          const targetLayer = params.busLayerAssignments[seedBus.busId]
          if (!targetLayer || !seedBus.exitEdge) return false
          const groupedBuses = boundaryBuses.filter(
            (bus) =>
              bus.componentId === seedBus.componentId &&
              bus.exitEdge === seedBus.exitEdge &&
              bus.connections.length <= 2 &&
              busUsesCoordinatedWinding(bus) &&
              params.busLayerAssignments[bus.busId] === targetLayer &&
              bus.connections.every(
                (connection) => connection.sourceLayer !== targetLayer,
              ),
          )
          const groupedBusIds = new Set(groupedBuses.map((bus) => bus.busId))
          const groupedConnectionCount = groupedBuses.reduce(
            (count, bus) => count + bus.connections.length,
            0,
          )
          return (
            groupedBuses.length >= 3 &&
            groupedConnectionCount >= 5 &&
            groupedConnectionCount <= 12 &&
            remainingBuses.every((bus) => groupedBusIds.has(bus.busId))
          )
        })
      }
      const jointMapRoutesWithCheapInterleaves = (
        candidateViaPoints: ReadonlyMap<number, { x: number; y: number }>,
        routingOrder: readonly PreparedBus[],
        preservePlaneCapacity = false,
        expandedStateBudget: {
          remaining: number
          exhausted: boolean
        } = denseExpandedStateBudget,
        routeSearchPolicy: DenseFixedMapSearchPolicy = fixedMapSearchPolicy,
      ): {
        plans: FanoutRoutePlan[]
        failedBus: PreparedBus | null
        viaPoints: Map<number, { x: number; y: number }>
      } => {
        const candidatePlans: FanoutRoutePlan[] = []
        const isBoundaryFirstLineage =
          boundaryFirstFallback &&
          routingOrder === legacyInterleavedRoutingOrder.buses
        const preRoutedBoundaryBuses = new Set<PreparedBus>()
        let routedCandidateViaPoints = new Map(candidateViaPoints)
        for (const deferredPairBus of trailingPairBusSet) {
          for (const connection of deferredPairBus.connections) {
            routedCandidateViaPoints.delete(connection.connectionIndex)
          }
        }
        for (const bus of routingOrder) {
          if (expandedStateBudget.remaining <= 0) {
            expandedStateBudget.exhausted = true
            return {
              plans: candidatePlans,
              failedBus: bus,
              viaPoints: routedCandidateViaPoints,
            }
          }
          if (preRoutedBoundaryBuses.has(bus)) continue
          if (
            bus.connections.some(
              (connection) =>
                !routedCandidateViaPoints.has(connection.connectionIndex),
            )
          ) {
            const extendedViaPoints = matchComponentDogboneViaSites(
              [...initiallyMatchedBoundaryBuses, bus],
              {
                ...jointMatchingRules,
                fixedViaPointsByConnectionIndex: routedCandidateViaPoints,
                blockingSegments: candidatePlans.flatMap((plan) =>
                  plan.segments.map((segment) => ({
                    connectionIndex: plan.connectionIndex,
                    segment,
                  })),
                ),
              },
            )
            if (!extendedViaPoints) {
              return {
                plans: candidatePlans,
                failedBus: bus,
                viaPoints: routedCandidateViaPoints,
              }
            }
            routedCandidateViaPoints = new Map([
              ...routedCandidateViaPoints,
              ...extendedViaPoints,
            ])
          }
          const targetLayer = params.busLayerAssignments[bus.busId]
          if (!targetLayer) {
            return {
              plans: candidatePlans,
              failedBus: bus,
              viaPoints: routedCandidateViaPoints,
            }
          }
          const effectiveBus = getBusWithDenseSearchCornerBandOffset({
            bus,
            useGloballyPackedCornerBandLanes:
              routeSearchPolicy.useGloballyPackedCornerBandLanes,
            legacyCornerBandExitLaneOffsetByBusId,
          })
          const initialBusBudget = Math.min(
            expandedStateBudget.remaining,
            1_500_000,
          )
          const busBudget = { remaining: initialBusBudget }
          const currentConnectionIndexes = new Set(
            bus.connections.map((connection) => connection.connectionIndex),
          )
          const reservedVias = (
            boundaryFirstFallback
              ? boundaryBuses
              : [...boundaryBuses, ...planeBuses]
          ).flatMap((preparedBus) => {
            const reservedTargetLayer =
              params.busLayerAssignments[preparedBus.busId]
            if (!reservedTargetLayer) return []
            return preparedBus.connections.flatMap((connection) => {
              if (currentConnectionIndexes.has(connection.connectionIndex)) {
                return []
              }
              const center = routedCandidateViaPoints.get(
                connection.connectionIndex,
              )
              return center
                ? [
                    {
                      connectionName: connection.connection.name,
                      via: {
                        center,
                        diameter: this.config.viaDiameter,
                        spanLayers: getViaSpanLayers({
                          fromLayer: connection.sourceLayer,
                          toLayer: reservedTargetLayer,
                          layerNames: this.config.layerNames,
                          allowBlindAndBuriedVias: false,
                        }),
                      },
                    },
                  ]
                : []
            })
          })
          const routeParams = {
            srj: this.routingSrj,
            bus: effectiveBus,
            targetLayer,
            acceptedPlans: candidatePlans,
            layerNames: this.config.layerNames,
            traceWidth: this.config.traceWidth,
            viaDiameter: this.config.viaDiameter,
            viaHoleDiameter: this.config.viaHoleDiameter,
            clearance: this.config.clearance,
            compactBusTracks: this.config.compactBusTracks,
            allowBlindAndBuriedVias: false,
            allowSameNetMerges: this.config.allowSameNetMerges,
            staticClearanceCache: this.routeStaticClearanceCache,
            fixedViaPointsByConnectionIndex: routedCandidateViaPoints,
            reservedVias,
            viaMinimalOnly: true,
            fixedViaWindingOnly: routeSearchPolicy.useFixedViaWindingOnly,
            cornerBandTargetTrackOffset: getCornerBandTargetTrackOffset(bus),
          } as const
          let plans: FanoutRoutePlan[] | null =
            routeBusAlternatives(
              routeSearchPolicy.useExpandedStateSearch
                ? { ...routeParams, expandedStateBudget: busBudget }
                : routeParams,
              1,
            )[0] ?? null
          let consumedBusStates = routeSearchPolicy.useExpandedStateSearch
            ? initialBusBudget - busBudget.remaining
            : 0
          if (
            routeSearchPolicy.useExpandedStateSearch &&
            !isBoundaryFirstLineage &&
            !plans &&
            bus.connections.length >= 4
          ) {
            // The deterministic fixed-order probe is intentionally cheap, but
            // it can miss a legal reverse/interleaved order and let later
            // buses fence the remaining corridor. Pay for the released
            // bounded order search here, while the corridor is still open,
            // rather than relying on a much larger downstream rip-up.
            const initialCenterFallbackBudget = Math.min(
              Math.max(0, expandedStateBudget.remaining - consumedBusStates),
              8_000_000,
            )
            const centerFallbackBudget = {
              remaining: initialCenterFallbackBudget,
            }
            plans =
              routeBusAlternatives(
                {
                  ...routeParams,
                  fixedViaWindingOnly: false,
                  expandedStateBudget: centerFallbackBudget,
                },
                1,
              )[0] ?? null
            consumedBusStates +=
              initialCenterFallbackBudget - centerFallbackBudget.remaining
          }
          if (
            plans &&
            preservePlaneCapacity &&
            routeSearchPolicy.usePlaneCapacityReplay
          ) {
            const capacityGroups = getNewlyBlockedPlaneCapacityGroups({
              acceptedPlans: candidatePlans,
              candidatePlans: plans,
            })
            if (capacityGroups === null) {
              plans = null
            } else if (capacityGroups.length > 0) {
              const initialCapacityRepairBudget = Math.min(
                Math.max(0, expandedStateBudget.remaining - consumedBusStates),
                1_500_000,
              )
              const capacityRepairBudget = {
                remaining: initialCapacityRepairBudget,
              }
              const capacityAwareAlternatives = routeBusAlternatives(
                {
                  ...routeParams,
                  fixedViaWindingOnly: false,
                  softViaCapacityGroups: capacityGroups,
                  ...(routeSearchPolicy.useExpandedStateSearch
                    ? { expandedStateBudget: capacityRepairBudget }
                    : {}),
                },
                1,
              )
              consumedBusStates +=
                initialCapacityRepairBudget - capacityRepairBudget.remaining
              plans = null
              for (const alternative of capacityAwareAlternatives) {
                const completedPlans = [...candidatePlans, ...alternative]
                const unavailablePlaneConnections = new Set(
                  getPlaneConnectionsWithoutCandidate(completedPlans),
                )
                if (
                  capacityGroups.some((group) =>
                    unavailablePlaneConnections.has(group.connectionIndex),
                  )
                ) {
                  continue
                }
                const actualBoundaryViaPoints = getRoutedBoundaryViaPoints(
                  completedPlans,
                  routedCandidateViaPoints,
                )
                const completeViaPoints =
                  matchCompleteDogboneMapAroundBoundaryPlans({
                    plans: completedPlans,
                    boundaryViaPoints: actualBoundaryViaPoints,
                    preferredViaPoints: routedCandidateViaPoints,
                  })
                plans = alternative
                if (completeViaPoints) {
                  routedCandidateViaPoints = completeViaPoints
                }
                break
              }
            }
          }
          expandedStateBudget.remaining -= consumedBusStates
          if (expandedStateBudget.remaining <= 0) {
            expandedStateBudget.exhausted = true
          }
          if (!plans) {
            return {
              plans: candidatePlans,
              failedBus: bus,
              viaPoints: routedCandidateViaPoints,
            }
          }
          candidatePlans.push(...plans)
          const deferredFollowers = [
            ...trailingPairWideOwnerByBus.entries(),
            ...provisionalWideOwnerByBus.entries(),
          ]
            .filter(
              ([follower, owner]) =>
                owner === bus &&
                follower.connections.some(
                  (connection) =>
                    !routedCandidateViaPoints.has(connection.connectionIndex),
                ),
            )
            .map(([follower]) => follower)
          if (deferredFollowers.length > 0) {
            const extendedViaPointAlternatives =
              matchComponentDogboneViaSiteAlternatives(
                [...fixedReservationBoundaryBuses, ...deferredFollowers],
                {
                  ...jointMatchingRules,
                  fixedViaPointsByConnectionIndex: routedCandidateViaPoints,
                  blockingSegments: candidatePlans.flatMap((plan) =>
                    plan.segments.map((segment) => ({
                      connectionIndex: plan.connectionIndex,
                      segment,
                    })),
                  ),
                },
                8,
              )
            if (extendedViaPointAlternatives.length === 0) {
              return {
                plans: candidatePlans,
                failedBus: deferredFollowers[0]!,
                viaPoints: routedCandidateViaPoints,
              }
            }
            const deferredPairs = deferredFollowers.filter((follower) =>
              trailingPairBusSet.has(follower),
            )
            if (deferredPairs.length === 0) {
              routedCandidateViaPoints = new Map([
                ...routedCandidateViaPoints,
                ...extendedViaPointAlternatives[0]!,
              ])
            } else {
              let selectedDeferredPlans: FanoutRoutePlan[] | null = null
              let selectedDeferredViaPoints: Map<
                number,
                { x: number; y: number }
              > | null = null
              for (const extendedViaPoints of extendedViaPointAlternatives) {
                const deferredPlans: FanoutRoutePlan[] = []
                let allDeferredPairsRouted = true
                for (const deferredPair of deferredPairs) {
                  const deferredTargetLayer =
                    params.busLayerAssignments[deferredPair.busId]
                  if (!deferredTargetLayer) {
                    allDeferredPairsRouted = false
                    break
                  }
                  const deferredConnectionIndexes = new Set(
                    deferredPair.connections.map(
                      (connection) => connection.connectionIndex,
                    ),
                  )
                  const deferredReservedVias = boundaryBuses.flatMap(
                    (reservedBus) => {
                      const reservedTargetLayer =
                        params.busLayerAssignments[reservedBus.busId]
                      if (!reservedTargetLayer) return []
                      return reservedBus.connections.flatMap((connection) => {
                        if (
                          deferredConnectionIndexes.has(
                            connection.connectionIndex,
                          )
                        ) {
                          return []
                        }
                        const center = extendedViaPoints.get(
                          connection.connectionIndex,
                        )
                        return center
                          ? [
                              {
                                connectionName: connection.connection.name,
                                via: {
                                  center,
                                  diameter: this.config.viaDiameter,
                                  spanLayers: getViaSpanLayers({
                                    fromLayer: connection.sourceLayer,
                                    toLayer: reservedTargetLayer,
                                    layerNames: this.config.layerNames,
                                    allowBlindAndBuriedVias: false,
                                  }),
                                },
                              },
                            ]
                          : []
                      })
                    },
                  )
                  const initialDeferredBudget = Math.min(
                    expandedStateBudget.remaining,
                    720_000,
                  )
                  const deferredBudget = {
                    remaining: initialDeferredBudget,
                  }
                  const pairPlans = routeBusAlternatives(
                    {
                      srj: this.routingSrj,
                      bus: getBusWithDenseSearchCornerBandOffset({
                        bus: deferredPair,
                        useGloballyPackedCornerBandLanes:
                          routeSearchPolicy.useGloballyPackedCornerBandLanes,
                        legacyCornerBandExitLaneOffsetByBusId,
                      }),
                      targetLayer: deferredTargetLayer,
                      acceptedPlans: [...candidatePlans, ...deferredPlans],
                      layerNames: this.config.layerNames,
                      traceWidth: this.config.traceWidth,
                      viaDiameter: this.config.viaDiameter,
                      viaHoleDiameter: this.config.viaHoleDiameter,
                      clearance: this.config.clearance,
                      compactBusTracks: this.config.compactBusTracks,
                      allowBlindAndBuriedVias: false,
                      allowSameNetMerges: this.config.allowSameNetMerges,
                      staticClearanceCache: this.routeStaticClearanceCache,
                      fixedViaPointsByConnectionIndex: extendedViaPoints,
                      reservedVias: deferredReservedVias,
                      viaMinimalOnly: true,
                      ...(routeSearchPolicy.useExpandedStateSearch
                        ? { expandedStateBudget: deferredBudget }
                        : {}),
                      cornerBandTargetTrackOffset:
                        getCornerBandTargetTrackOffset(deferredPair),
                    },
                    1,
                  )[0]
                  if (routeSearchPolicy.useExpandedStateSearch) {
                    expandedStateBudget.remaining -=
                      initialDeferredBudget - deferredBudget.remaining
                  }
                  if (expandedStateBudget.remaining <= 0) {
                    expandedStateBudget.exhausted = true
                  }
                  if (!pairPlans) {
                    allDeferredPairsRouted = false
                    break
                  }
                  deferredPlans.push(...pairPlans)
                }
                if (!allDeferredPairsRouted) continue
                selectedDeferredPlans = deferredPlans
                selectedDeferredViaPoints = extendedViaPoints
                break
              }
              if (!selectedDeferredPlans || !selectedDeferredViaPoints) {
                return {
                  plans: candidatePlans,
                  failedBus: deferredPairs[0]!,
                  viaPoints: routedCandidateViaPoints,
                }
              }
              candidatePlans.push(...selectedDeferredPlans)
              routedCandidateViaPoints = new Map([
                ...routedCandidateViaPoints,
                ...selectedDeferredViaPoints,
              ])
              for (const deferredPair of deferredPairs) {
                preRoutedBoundaryBuses.add(deferredPair)
              }
            }
          }
        }
        return {
          plans: candidatePlans,
          failedBus: null,
          viaPoints: routedCandidateViaPoints,
        }
      }
      const repairTemplatePrefixForPlaneCapacity = (repairParams: {
        templatePlans: readonly FanoutRoutePlan[]
        candidateViaPoints: ReadonlyMap<number, { x: number; y: number }>
        routingOrder: readonly PreparedBus[]
      }): {
        plans: FanoutRoutePlan[]
        failedBus: PreparedBus | null
        viaPoints: Map<number, { x: number; y: number }>
      } => {
        const repairedPlans: FanoutRoutePlan[] = []
        let repairedViaPoints = new Map(repairParams.candidateViaPoints)
        const preservedPlaneCapacityConnectionIndexes = new Set<number>()

        for (const bus of repairParams.routingOrder) {
          const templateBusPlans = repairParams.templatePlans.filter(
            (plan) => plan.busId === bus.busId,
          )
          if (templateBusPlans.length === 0) continue
          if (templateBusPlans.length !== bus.connections.length) {
            return {
              plans: repairedPlans,
              failedBus: bus,
              viaPoints: repairedViaPoints,
            }
          }

          const templateCompletedPlans = [...repairedPlans, ...templateBusPlans]
          if (
            fanoutPlansAreClear({
              plans: templateCompletedPlans,
              srj: this.routingSrj,
              sharedBoundary: bus.sharedBoundary,
              clearance: this.config.clearance,
              allowBlindAndBuriedVias: false,
              allowSameNetMerges: this.config.allowSameNetMerges,
            })
          ) {
            const actualBoundaryViaPoints = getRoutedBoundaryViaPoints(
              templateCompletedPlans,
              repairedViaPoints,
            )
            const completeViaPoints =
              matchCompleteDogboneMapAroundBoundaryPlans({
                plans: templateCompletedPlans,
                boundaryViaPoints: actualBoundaryViaPoints,
                preferredViaPoints: repairedViaPoints,
              })
            if (completeViaPoints) {
              repairedPlans.push(...templateBusPlans)
              repairedViaPoints = completeViaPoints
              continue
            }
          }

          const newlyBlockedCapacityGroups = getNewlyBlockedPlaneCapacityGroups(
            {
              acceptedPlans: repairedPlans,
              candidatePlans: templateBusPlans,
            },
          )
          if (!newlyBlockedCapacityGroups) {
            return {
              plans: repairedPlans,
              failedBus: bus,
              viaPoints: repairedViaPoints,
            }
          }
          const capacityConnectionIndexes = [
            ...new Set([
              ...preservedPlaneCapacityConnectionIndexes,
              ...newlyBlockedCapacityGroups.map(
                (group) => group.connectionIndex,
              ),
            ]),
          ]
          if (capacityConnectionIndexes.length === 0) {
            return {
              plans: repairedPlans,
              failedBus: bus,
              viaPoints: repairedViaPoints,
            }
          }
          const capacityGroups = getPlaneCapacityGroups(
            capacityConnectionIndexes,
            repairedPlans,
          )
          if (capacityGroups.length !== capacityConnectionIndexes.length) {
            return {
              plans: repairedPlans,
              failedBus: bus,
              viaPoints: repairedViaPoints,
            }
          }
          const targetLayer = params.busLayerAssignments[bus.busId]
          if (!targetLayer) {
            return {
              plans: repairedPlans,
              failedBus: bus,
              viaPoints: repairedViaPoints,
            }
          }
          const routeViaPoints = new Map(repairedViaPoints)
          const currentConnectionIndexes = new Set(
            bus.connections.map((connection) => connection.connectionIndex),
          )
          const reservedVias = boundaryBuses.flatMap((reservedBus) => {
            const reservedTargetLayer =
              params.busLayerAssignments[reservedBus.busId]
            if (!reservedTargetLayer) return []
            return reservedBus.connections.flatMap((connection) => {
              if (currentConnectionIndexes.has(connection.connectionIndex)) {
                return []
              }
              const center = routeViaPoints.get(connection.connectionIndex)
              return center
                ? [
                    {
                      connectionName: connection.connection.name,
                      via: {
                        center,
                        diameter: this.config.viaDiameter,
                        spanLayers: getViaSpanLayers({
                          fromLayer: connection.sourceLayer,
                          toLayer: reservedTargetLayer,
                          layerNames: this.config.layerNames,
                          allowBlindAndBuriedVias: false,
                        }),
                      },
                    },
                  ]
                : []
            })
          })
          const initialRepairBudget = Math.min(
            denseExpandedStateBudget.remaining,
            bus.connections.length <= 2 ? 720_000 : 1_500_000,
          )
          const repairBudget = { remaining: initialRepairBudget }
          const baseRepairRouteParams = {
            srj: this.routingSrj,
            bus,
            targetLayer,
            acceptedPlans: repairedPlans,
            layerNames: this.config.layerNames,
            traceWidth: this.config.traceWidth,
            viaDiameter: this.config.viaDiameter,
            viaHoleDiameter: this.config.viaHoleDiameter,
            clearance: this.config.clearance,
            compactBusTracks: this.config.compactBusTracks,
            allowBlindAndBuriedVias: false,
            allowSameNetMerges: this.config.allowSameNetMerges,
            staticClearanceCache: this.routeStaticClearanceCache,
            fixedViaPointsByConnectionIndex: routeViaPoints,
            reservedVias,
            viaMinimalOnly: true,
            fixedViaWindingOnly: false,
            enableJointRouteSearch: bus.connections.length >= 4,
            cornerBandTargetTrackOffset: getCornerBandTargetTrackOffset(bus),
          } as const
          const alternatives = routeBusAlternatives(
            {
              ...baseRepairRouteParams,
              softViaCapacityGroups: capacityGroups,
              ...(fixedMapSearchPolicy.useExpandedStateSearch
                ? { expandedStateBudget: repairBudget }
                : {}),
            },
            4,
          )
          if (fixedMapSearchPolicy.useExpandedStateSearch) {
            denseExpandedStateBudget.remaining -=
              initialRepairBudget - repairBudget.remaining
          }
          const selectCapacityFeasibleAlternative = (
            candidateAlternatives: readonly FanoutRoutePlan[][],
          ): {
            plans: FanoutRoutePlan[]
            viaPoints: Map<number, { x: number; y: number }>
          } | null => {
            for (const alternative of candidateAlternatives) {
              const completedPlans = [...repairedPlans, ...alternative]
              const actualBoundaryViaPoints = getRoutedBoundaryViaPoints(
                completedPlans,
                routeViaPoints,
              )
              const completeViaPoints =
                matchCompleteDogboneMapAroundBoundaryPlans({
                  plans: completedPlans,
                  boundaryViaPoints: actualBoundaryViaPoints,
                  preferredViaPoints: repairedViaPoints,
                })
              if (!completeViaPoints) continue
              return { plans: alternative, viaPoints: completeViaPoints }
            }
            return null
          }
          let selected = selectCapacityFeasibleAlternative(alternatives)
          if (!selected) {
            const capacityConnectionIndexes = new Set(
              capacityGroups.map((group) => group.connectionIndex),
            )
            const planeCapacityReservations = planeBuses.flatMap((planeBus) =>
              planeBus.connections.flatMap((connection) => {
                if (
                  !capacityConnectionIndexes.has(connection.connectionIndex) ||
                  planeBus.termination.type !== "plane"
                ) {
                  return []
                }
                const center = repairedViaPoints.get(connection.connectionIndex)
                return center
                  ? [
                      {
                        connectionName: connection.connection.name,
                        via: {
                          center,
                          diameter: this.config.viaDiameter,
                          spanLayers: getViaSpanLayers({
                            fromLayer: connection.sourceLayer,
                            toLayer: planeBus.termination.layer,
                            layerNames: this.config.layerNames,
                            allowBlindAndBuriedVias: false,
                          }),
                        },
                      },
                    ]
                  : []
              }),
            )
            const initialHardRepairBudget = Math.min(
              denseExpandedStateBudget.remaining,
              bus.connections.length <= 2 ? 720_000 : 1_500_000,
            )
            const hardRepairBudget = { remaining: initialHardRepairBudget }
            const hardAlternatives = routeBusAlternatives(
              {
                ...baseRepairRouteParams,
                reservedVias: [...reservedVias, ...planeCapacityReservations],
                ...(fixedMapSearchPolicy.useExpandedStateSearch
                  ? { expandedStateBudget: hardRepairBudget }
                  : {}),
              },
              4,
            )
            if (fixedMapSearchPolicy.useExpandedStateSearch) {
              denseExpandedStateBudget.remaining -=
                initialHardRepairBudget - hardRepairBudget.remaining
            }
            selected = selectCapacityFeasibleAlternative(hardAlternatives)
          }
          if (!selected && bus.connections.length >= 4 && bus.exitEdge) {
            const boundaryDirection =
              bus.exitEdge === "left" || bus.exitEdge === "right"
                ? "vertical"
                : "horizontal"
            const orderedConnections = bus.connections.toSorted(
              (first, second) => {
                const firstTrack =
                  boundaryDirection === "vertical"
                    ? first.targetPoint.y
                    : first.targetPoint.x
                const secondTrack =
                  boundaryDirection === "vertical"
                    ? second.targetPoint.y
                    : second.targetPoint.x
                return (
                  firstTrack - secondTrack ||
                  first.connectionIndex - second.connectionIndex
                )
              },
            )
            const splitIndex = Math.floor(orderedConnections.length / 2)
            const lowerConnections = orderedConnections.slice(0, splitIndex)
            const upperConnections = orderedConnections.slice(splitIndex)
            const splitOrders = [
              [lowerConnections, upperConnections],
              [upperConnections, lowerConnections],
            ]

            for (const splitOrder of splitOrders) {
              const splitAcceptedPlans = [...repairedPlans]
              let splitViaPoints = new Map(routeViaPoints)
              let splitSucceeded = true
              for (const splitConnections of splitOrder) {
                const liveCapacityGroups = getPlaneCapacityGroups(
                  capacityGroups.map((group) => group.connectionIndex),
                  splitAcceptedPlans,
                )
                if (liveCapacityGroups.length !== capacityGroups.length) {
                  splitSucceeded = false
                  break
                }
                const splitConnectionIndexes = new Set(
                  splitConnections.map(
                    (connection) => connection.connectionIndex,
                  ),
                )
                const splitReservedVias = boundaryBuses.flatMap(
                  (reservedBus) => {
                    const reservedTargetLayer =
                      params.busLayerAssignments[reservedBus.busId]
                    if (!reservedTargetLayer) return []
                    return reservedBus.connections.flatMap((connection) => {
                      if (
                        splitConnectionIndexes.has(connection.connectionIndex)
                      ) {
                        return []
                      }
                      const center = splitViaPoints.get(
                        connection.connectionIndex,
                      )
                      return center
                        ? [
                            {
                              connectionName: connection.connection.name,
                              via: {
                                center,
                                diameter: this.config.viaDiameter,
                                spanLayers: getViaSpanLayers({
                                  fromLayer: connection.sourceLayer,
                                  toLayer: reservedTargetLayer,
                                  layerNames: this.config.layerNames,
                                  allowBlindAndBuriedVias: false,
                                }),
                              },
                            },
                          ]
                        : []
                    })
                  },
                )
                const initialSplitBudget = Math.min(
                  denseExpandedStateBudget.remaining,
                  1_500_000,
                )
                const splitBudget = { remaining: initialSplitBudget }
                const splitAlternatives = routeBusAlternatives(
                  {
                    ...baseRepairRouteParams,
                    bus: {
                      ...bus,
                      maxLengthSkew: undefined,
                      connections: splitConnections,
                    },
                    acceptedPlans: splitAcceptedPlans,
                    fixedViaPointsByConnectionIndex: splitViaPoints,
                    reservedVias: splitReservedVias,
                    softViaCapacityGroups: liveCapacityGroups,
                    ...(fixedMapSearchPolicy.useExpandedStateSearch
                      ? { expandedStateBudget: splitBudget }
                      : {}),
                  },
                  2,
                )
                if (fixedMapSearchPolicy.useExpandedStateSearch) {
                  denseExpandedStateBudget.remaining -=
                    initialSplitBudget - splitBudget.remaining
                }
                let selectedSplit:
                  | {
                      plans: FanoutRoutePlan[]
                      viaPoints: Map<number, { x: number; y: number }>
                    }
                  | undefined
                for (const splitPlans of splitAlternatives) {
                  const completedPlans = [...splitAcceptedPlans, ...splitPlans]
                  const actualBoundaryViaPoints = getRoutedBoundaryViaPoints(
                    completedPlans,
                    splitViaPoints,
                  )
                  const completeViaPoints =
                    matchCompleteDogboneMapAroundBoundaryPlans({
                      plans: completedPlans,
                      boundaryViaPoints: actualBoundaryViaPoints,
                      preferredViaPoints: splitViaPoints,
                    })
                  if (!completeViaPoints) continue
                  selectedSplit = {
                    plans: splitPlans,
                    viaPoints: completeViaPoints,
                  }
                  break
                }
                if (!selectedSplit) {
                  splitSucceeded = false
                  break
                }
                splitAcceptedPlans.push(...selectedSplit.plans)
                splitViaPoints = selectedSplit.viaPoints
              }
              if (!splitSucceeded) continue
              const splitPlans = splitAcceptedPlans.slice(repairedPlans.length)
              if (splitPlans.length !== bus.connections.length) continue
              selected = { plans: splitPlans, viaPoints: splitViaPoints }
              break
            }
          }
          if (!selected) {
            return {
              plans: repairedPlans,
              failedBus: bus,
              viaPoints: repairedViaPoints,
            }
          }
          repairedPlans.push(...selected.plans)
          repairedViaPoints = selected.viaPoints
          for (const group of capacityGroups) {
            preservedPlaneCapacityConnectionIndexes.add(group.connectionIndex)
          }
        }

        return {
          plans: repairedPlans,
          failedBus: null,
          viaPoints: repairedViaPoints,
        }
      }
      const tryReleasedDenseAdaptivePreflight =
        (): MixedTerminationState | null => {
          if (!releasedSeedViaPoints) return null
          let fixedViaPointsByConnectionIndex: ReadonlyMap<
            number,
            { x: number; y: number }
          > = releasedSeedViaPoints
          let matchedPlans: FanoutRoutePlan[] = []
          let matchedRoutingSucceeded = true

          const getReservedVias = (bus: PreparedBus) => {
            const currentConnectionNames = new Set(
              bus.connections.map((connection) => connection.connection.name),
            )
            return [...boundaryBuses, ...planeBuses].flatMap((preparedBus) => {
              const targetLayer = params.busLayerAssignments[preparedBus.busId]
              if (!targetLayer) return []
              return preparedBus.connections.flatMap((connection) => {
                if (currentConnectionNames.has(connection.connection.name)) {
                  return []
                }
                const center = fixedViaPointsByConnectionIndex.get(
                  connection.connectionIndex,
                )
                return center
                  ? [
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
                  : []
              })
            })
          }

          const routeMatchedBoundaryBus = (bus: PreparedBus): boolean => {
            const targetLayer = params.busLayerAssignments[bus.busId]
            if (!targetLayer) return false
            const releasedBus = getBusWithDenseSearchCornerBandOffset({
              bus,
              useGloballyPackedCornerBandLanes: false,
              legacyCornerBandExitLaneOffsetByBusId,
            })
            const routeParams = {
              srj: this.routingSrj,
              bus: releasedBus,
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
              viaMinimalOnly: true,
              expandedStateBudget: releasedAdaptivePreflightSearchBudget,
              cornerBandTargetTrackOffset:
                getReleasedCornerBandTargetTrackOffset(bus),
            } as const
            let busPlans = routeBusAlternatives(routeParams, 1)[0]
            if (busPlans && bus.maxLengthSkew !== undefined) {
              const lengths = busPlans.map((plan) => plan.length)
              const rawSkew = Math.max(...lengths) - Math.min(...lengths)
              if (
                shouldSearchReleasedDenseBoundaryRouteTopologies({
                  boundaryBusCount: boundaryBuses.length,
                  planeBusCount: planeBuses.length,
                  connectionCount: bus.connections.length,
                  rawSkew,
                  maximumSkew: bus.maxLengthSkew,
                })
              ) {
                const diverseBusPlans = routeBusAlternatives(routeParams, 3)
                busPlans = diverseBusPlans.toSorted((first, second) => {
                  const firstLengths = first.map((plan) => plan.length)
                  const secondLengths = second.map((plan) => plan.length)
                  return (
                    Math.max(...firstLengths) -
                    Math.min(...firstLengths) -
                    (Math.max(...secondLengths) - Math.min(...secondLengths))
                  )
                })[0]
              }
            }
            if (!busPlans) return false
            matchedPlans.push(...busPlans)
            return true
          }

          const firstBoundaryBus = releasedDenseBoundaryBusesInRoutingOrder[0]!
          const routedBoundaryBuses: PreparedBus[] = []
          if (routeMatchedBoundaryBus(firstBoundaryBus)) {
            routedBoundaryBuses.push(firstBoundaryBus)
          } else {
            matchedRoutingSucceeded = false
          }
          const remainingBoundaryBuses =
            releasedDenseBoundaryBusesInRoutingOrder.slice(1)
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
              const candidateHasFixedViaPoints = candidateBus.connections.every(
                (connection) =>
                  fixedViaPointsByConnectionIndex.has(
                    connection.connectionIndex,
                  ),
              )
              const extendedViaPoints =
                releasedJointViaPoints && candidateHasFixedViaPoints
                  ? new Map(fixedViaPointsByConnectionIndex)
                  : matchComponentDogboneViaSites(
                      [...planeBuses, ...routedBoundaryBuses, candidateBus],
                      {
                        ...releasedJointMatchingRules,
                        fixedViaPointsByConnectionIndex,
                        blockingSegments,
                      },
                    )
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
                    ...planeBuses,
                    ...routedBoundaryBuses,
                    candidateBus,
                    laterBus,
                  ],
                  {
                    ...releasedJointMatchingRules,
                    fixedViaPointsByConnectionIndex: extendedViaPoints,
                    blockingSegments,
                  },
                )
                if (futureAssignment) {
                  const candidateCountByConnectionIndex = new Map<
                    number,
                    number
                  >()
                  for (const candidate of getComponentDogboneViaSiteCandidates(
                    [laterBus],
                    {
                      ...releasedJointMatchingRules,
                      blockingSegments,
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
                      (candidateCountByConnectionIndex.get(
                        first.connectionIndex,
                      ) ?? 0) -
                        (candidateCountByConnectionIndex.get(
                          second.connectionIndex,
                        ) ?? 0) ||
                      first.connectionIndex - second.connectionIndex,
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
              if (routeMatchedBoundaryBus(candidateBus)) {
                const candidateLeavesAFeasibleExtension =
                  laterBuses.length === 0 ||
                  Boolean(
                    matchComponentDogboneViaSites(
                      [
                        ...planeBuses,
                        ...routedBoundaryBuses,
                        candidateBus,
                        ...laterBuses,
                      ],
                      {
                        ...releasedJointMatchingRules,
                        fixedViaPointsByConnectionIndex,
                        blockingSegments: matchedPlans.flatMap((plan) =>
                          plan.segments.map((segment) => ({
                            connectionIndex: plan.connectionIndex,
                            segment,
                          })),
                        ),
                      },
                    ),
                  )
                if (candidateLeavesAFeasibleExtension) {
                  selectedBusIndex = candidateIndex
                  routedBoundaryBuses.push(candidateBus)
                  break
                }
                matchedPlans.splice(previousPlanCount)
              }
              fixedViaPointsByConnectionIndex = previousFixedViaPoints
            }
            if (selectedBusIndex < 0) {
              matchedRoutingSucceeded = false
              break
            }
            remainingBoundaryBuses.splice(selectedBusIndex, 1)
          }

          let selectedCompletion: DenseDogboneCompletionAssignment | null = null
          if (matchedRoutingSucceeded) {
            const completionByBoundaryGeometry = new Map<
              string,
              DenseDogboneCompletionAssignment
            >()
            const directViaPointsByBoundaryGeometry = new Map<
              string,
              Map<number, Point2D>
            >()
            const matchViaPointsAroundPlans = (
              candidatePlans: readonly FanoutRoutePlan[],
            ): Map<number, { x: number; y: number }> | null => {
              const fixedBoundaryViaPoints = new Map(
                candidatePlans.flatMap((plan) =>
                  plan.via
                    ? [[plan.connectionIndex, plan.via.center] as const]
                    : [],
                ),
              )
              return matchComponentDogboneViaSites(
                [...planeBuses, ...boundaryBuses],
                {
                  ...releasedJointMatchingRules,
                  fixedViaPointsByConnectionIndex: fixedBoundaryViaPoints,
                  blockingSegments: candidatePlans.flatMap((plan) =>
                    plan.segments.map((segment) => ({
                      connectionIndex: plan.connectionIndex,
                      segment,
                    })),
                  ),
                },
              )
            }
            const matchDirectAroundPlans = (
              candidatePlans: readonly FanoutRoutePlan[],
            ): Map<number, Point2D> | null => {
              const geometryKey =
                getDenseBoundaryPlanGeometryKey(candidatePlans)
              if (directViaPointsByBoundaryGeometry.has(geometryKey)) {
                return (
                  directViaPointsByBoundaryGeometry.get(geometryKey) ?? null
                )
              }
              const viaPoints = matchViaPointsAroundPlans(candidatePlans)
              if (viaPoints) {
                directViaPointsByBoundaryGeometry.set(geometryKey, viaPoints)
              }
              return viaPoints
            }
            const matchCompletionAroundPlans = (
              candidatePlans: readonly FanoutRoutePlan[],
            ): DenseDogboneCompletionAssignment | null =>
              matchDenseDogboneCompletionDirectFirstCached({
                geometryKey: getDenseBoundaryPlanGeometryKey(candidatePlans),
                completionByGeometry: completionByBoundaryGeometry,
                matchDirect: () => matchDirectAroundPlans(candidatePlans),
                matchPaths: () =>
                  matchCompleteDogbonePathsAroundBoundaryPlans({
                    plans: candidatePlans,
                    boundaryViaPoints: fixedViaPointsByConnectionIndex,
                    preferredViaPoints: fixedViaPointsByConnectionIndex,
                    useReleasedMatchingRules: true,
                  }),
              })
            const lengthMatchingParams = {
              plans: matchedPlans,
              preparedBuses: this.preparedBuses,
              inputSrj: this.inputSrj,
              sharedBoundary: this.getValidationBoundary(),
              clearance: this.config.clearance,
              allowBlindAndBuriedVias: false,
              allowSameNetMerges: this.config.allowSameNetMerges,
              allowMatchingInsideDenseBounds: true,
            } as const
            const selectMatchedLengthPlans = (): FanoutRoutePlan[] | null =>
              matchBusPlanLengths({
                ...lengthMatchingParams,
                candidatePlansAreFeasible: (candidatePlans) =>
                  Boolean(matchDirectAroundPlans(candidatePlans)),
              }).plans ?? matchBusPlanLengths(lengthMatchingParams).plans
            if (planeBuses.length === 0) {
              const matchedLengthPlans = selectMatchedLengthPlans()
              if (matchedLengthPlans) {
                matchedPlans = matchedLengthPlans
              } else {
                matchedRoutingSucceeded = false
              }
            } else {
              const selection = selectDenseLengthPlansThenMatchDogbones({
                selectPlans: selectMatchedLengthPlans,
                matchFinalCompletion: matchCompletionAroundPlans,
              })
              if (selection?.completion?.kind === "direct") {
                matchedPlans = [...selection.plans]
                selectedCompletion = selection.completion
                fixedViaPointsByConnectionIndex = selection.completion.viaPoints
              } else if (selection?.completion?.kind === "path") {
                matchedPlans = [...selection.plans]
                selectedCompletion = selection.completion
                fixedViaPointsByConnectionIndex = new Map(
                  [...selection.completion.viaPaths].map(
                    ([connectionIndex, assignment]) =>
                      [connectionIndex, assignment.point] as const,
                  ),
                )
              } else {
                matchedRoutingSucceeded = false
              }
            }
          }

          if (matchedRoutingSucceeded) {
            const fixedSourceEscapePathsByConnectionIndex =
              getDenseCompletionSourceEscapePaths(selectedCompletion)
            for (const bus of planeBuses) {
              const targetLayer = params.busLayerAssignments[bus.busId]
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
                    fixedViaPointsByConnectionIndex,
                    fixedSourceEscapePathsByConnectionIndex,
                    expandedStateBudget: releasedAdaptivePreflightSearchBudget,
                  })
                : null
              if (!busPlans) {
                matchedRoutingSucceeded = false
                break
              }
              matchedPlans.push(...busPlans)
            }
          }

          const releasedPlansAreClear =
            matchedRoutingSucceeded &&
            fanoutPlansAreClear({
              plans: matchedPlans,
              srj: this.routingSrj,
              sharedBoundary: boundaryBuses[0]!.sharedBoundary,
              clearance: this.config.clearance,
              allowBlindAndBuriedVias: false,
              allowSameNetMerges: this.config.allowSameNetMerges,
            })
          if (releasedPlansAreClear) {
            return { plans: matchedPlans, failedBusIds: [] }
          }
          return null
        }
      const releasedAdaptivePreflight =
        runReleasedDenseAdaptivePreflightIfEligible({
          eligible: useReleasedDenseAdaptivePreflight,
          runPreflight: tryReleasedDenseAdaptivePreflight,
        })
      if (releasedAdaptivePreflight) return releasedAdaptivePreflight
      const stagedBoundaryAttempted =
        boundaryBuses.length >= 9 &&
        planeBuses.length > 0 &&
        (boundaryBuses.every((bus) => bus.exitEdge === "bottom") ||
          boundaryBuses.every((bus) => bus.exitEdge === "left"))
      const stagedBoundarySeed = stagedBoundaryAttempted
        ? tryStagedNarrowFirstBoundary.call(this)
        : null
      if (stagedBoundarySeed) {
        jointViaPoints = stagedBoundarySeed.viaPoints
      }
      let cheapJointPlans: FanoutRoutePlan[] | null =
        stagedBoundarySeed?.plans ?? null
      let pendingJointMaps = (
        stagedBoundarySeed ? [] : jointViaPointAlternatives
      ).map((map) => ({
        map,
        depth: 0,
        parentPlanCount: -1,
        preferredRoutingOrder: boundaryFirstFallback
          ? legacyInterleavedRoutingOrder
          : denseBoundaryRoutingOrders[0]!,
      }))
      const seenBoundarySignatures = new Set(
        jointViaPointAlternatives.map(getBoundarySignature),
      )
      const maximumRouteGuidedJointProbes = 20
      const maximumRouteGuidedRepairDepth = 5
      const maximumRootOrderSelectionStates = 4_000_000
      const legacyFixedMapSearchPolicy: DenseFixedMapSearchPolicy = {
        useExpandedStateSearch: false,
        useFixedViaWindingOnly: false,
        useGloballyPackedCornerBandLanes: false,
        usePathAwareJointPlaneReservation: false,
        usePlaneCapacityReplay: false,
      }
      let probedJointOrderCount = 0
      type DenseJointProbe = {
        plans: FanoutRoutePlan[]
        failedBus: PreparedBus | null
        viaPoints: Map<number, { x: number; y: number }>
        routingOrder: DenseBoundaryRoutingOrderCandidate<PreparedBus>
        orderRank: number
        unavailablePlaneCount: number
        canCompleteAsNarrowBundle: boolean
        routedConnectionCount: number
        routedBusCount: number
        signature: string
      }
      const compareDenseJointProbes = (
        first: DenseJointProbe,
        second: DenseJointProbe,
      ): number =>
        Number(second.failedBus === null) - Number(first.failedBus === null) ||
        Number(second.canCompleteAsNarrowBundle) -
          Number(first.canCompleteAsNarrowBundle) ||
        second.routedConnectionCount - first.routedConnectionCount ||
        first.unavailablePlaneCount - second.unavailablePlaneCount ||
        second.routedBusCount - first.routedBusCount ||
        (first.failedBus?.connections.length ?? 0) -
          (second.failedBus?.connections.length ?? 0) ||
        first.orderRank - second.orderRank ||
        first.signature.localeCompare(second.signature)
      const compareDenseRootOrderProbes = (
        first: DenseJointProbe,
        second: DenseJointProbe,
      ): number =>
        Number(second.failedBus === null) - Number(first.failedBus === null) ||
        Number(second.canCompleteAsNarrowBundle) -
          Number(first.canCompleteAsNarrowBundle) ||
        second.routedConnectionCount - first.routedConnectionCount ||
        first.orderRank - second.orderRank ||
        first.signature.localeCompare(second.signature)
      const createDenseJointProbe = (
        probe: {
          plans: FanoutRoutePlan[]
          failedBus: PreparedBus | null
          viaPoints: Map<number, { x: number; y: number }>
        },
        routingOrder: DenseBoundaryRoutingOrderCandidate<PreparedBus>,
      ): DenseJointProbe => {
        const routedConnectionIndexes = new Set(
          probe.plans.map((plan) => plan.connectionIndex),
        )
        return {
          ...probe,
          routingOrder,
          orderRank: denseBoundaryRoutingOrders.indexOf(routingOrder),
          unavailablePlaneCount: getPlaneConnectionsWithoutCandidate(
            probe.plans,
          ).length,
          canCompleteAsNarrowBundle:
            remainingBoundaryBusesCanBeCompletedAsNarrowBundle(probe.plans),
          routedConnectionCount: routedConnectionIndexes.size,
          routedBusCount: new Set(probe.plans.map((plan) => plan.busId)).size,
          signature: `${getBoundarySignature(probe.viaPoints)}|${[
            ...routedConnectionIndexes,
          ]
            .toSorted((first, second) => first - second)
            .join(",")}`,
        }
      }
      let bestCheapJointProbe: DenseJointProbe | null = null
      const maximumCapacityReplayCandidates = 1
      const capacityReplayCandidates: DenseJointProbe[] = []
      while (
        pendingJointMaps.length > 0 &&
        probedJointOrderCount < maximumRouteGuidedJointProbes &&
        denseExpandedStateBudget.remaining > 0
      ) {
        const candidate = pendingJointMaps.shift()!
        let selectedRoutingOrder = boundaryFirstFallback
          ? legacyInterleavedRoutingOrder
          : candidate.preferredRoutingOrder
        let reusableLegacyRootProbe: DenseJointProbe | null = null
        if (!boundaryFirstFallback && candidate.depth === 0) {
          let expandedRootOrderProbes: DenseJointProbe[] = []
          const rootSelection = runLegacyFirstDenseRootProbe({
            probeLegacy: () => {
              const rootSelectionBudget = {
                remaining: maximumRootOrderSelectionStates,
                exhausted: false,
              }
              return createDenseJointProbe(
                jointMapRoutesWithCheapInterleaves(
                  candidate.map,
                  legacyInterleavedRoutingOrder.buses,
                  false,
                  rootSelectionBudget,
                  legacyFixedMapSearchPolicy,
                ),
                legacyInterleavedRoutingOrder,
              )
            },
            legacyIsUsable: (probe) =>
              probe.failedBus === null && probe.unavailablePlaneCount === 0,
            probeExpanded: () => {
              expandedRootOrderProbes = denseBoundaryRoutingOrders.map(
                (routingOrder) => {
                  const rootSelectionBudget = {
                    remaining: maximumRootOrderSelectionStates,
                    exhausted: false,
                  }
                  return createDenseJointProbe(
                    jointMapRoutesWithCheapInterleaves(
                      candidate.map,
                      routingOrder.buses,
                      false,
                      rootSelectionBudget,
                    ),
                    routingOrder,
                  )
                },
              )
              return expandedRootOrderProbes.toSorted(
                compareDenseRootOrderProbes,
              )[0]!
            },
          })
          if (
            rootSelection.usedExpandedSearch &&
            shouldUseDenseBoundaryFirstFallback({
              totalBoundaryConnectionCount: boundaryBuses.reduce(
                (count, bus) => count + bus.connections.length,
                0,
              ),
              planeBusCount: planeBuses.length,
              boundaryExitEdges: boundaryBuses.map((bus) => bus.exitEdge),
              rootProbes: expandedRootOrderProbes.map((probe) => ({
                failed: probe.failedBus !== null,
                planCount: probe.plans.length,
              })),
            })
          ) {
            return this.routeDenseThroughAllMixedTerminations({
              ...params,
              boundaryFirstFallback: true,
            })
          }
          selectedRoutingOrder = rootSelection.probe.routingOrder
          if (!rootSelection.usedExpandedSearch) {
            reusableLegacyRootProbe = rootSelection.probe
          }
        }
        const routingOrders = [selectedRoutingOrder]
        const orderProbes: DenseJointProbe[] = reusableLegacyRootProbe
          ? [reusableLegacyRootProbe]
          : []
        if (!reusableLegacyRootProbe) {
          for (const routingOrder of routingOrders) {
            if (
              probedJointOrderCount >= maximumRouteGuidedJointProbes ||
              denseExpandedStateBudget.remaining <= 0
            ) {
              break
            }
            probedJointOrderCount++
            const orderProbe = createDenseJointProbe(
              jointMapRoutesWithCheapInterleaves(
                candidate.map,
                routingOrder.buses,
              ),
              routingOrder,
            )
            orderProbes.push(orderProbe)
            if (
              orderProbe.failedBus === null ||
              orderProbe.canCompleteAsNarrowBundle
            ) {
              break
            }
          }
        }
        const probe = orderProbes.toSorted(compareDenseJointProbes)[0]
        if (!probe) break
        if (
          !bestCheapJointProbe ||
          (boundaryFirstFallback
            ? probe.plans.length > bestCheapJointProbe.plans.length
            : compareDenseJointProbes(probe, bestCheapJointProbe) < 0)
        ) {
          bestCheapJointProbe = probe
          pendingJointMaps = pendingJointMaps.filter(
            (pending) => pending.parentPlanCount >= probe.plans.length,
          )
          if (probe.plans.length > bestDensePartialPlans.length) {
            bestDensePartialPlans = [...probe.plans]
          }
        }
        if (
          !reusableLegacyRootProbe &&
          !boundaryFirstFallback &&
          probe.canCompleteAsNarrowBundle
        ) {
          const signature = getBoundarySignature(probe.viaPoints)
          if (
            !capacityReplayCandidates.some(
              (replayCandidate) =>
                replayCandidate.routingOrder.kind === probe.routingOrder.kind &&
                getBoundarySignature(replayCandidate.viaPoints) === signature,
            )
          ) {
            capacityReplayCandidates.push(probe)
          }
          if (
            capacityReplayCandidates.length >= maximumCapacityReplayCandidates
          ) {
            break
          }
        }
        if (!probe.failedBus) break
        if (
          candidate.depth >= maximumRouteGuidedRepairDepth ||
          probe.plans.length <= candidate.parentPlanCount
        ) {
          continue
        }

        const failedSourceBounds = probe.failedBus.connections.reduce(
          (bounds, connection) => ({
            minX: Math.min(bounds.minX, connection.sourcePoint.x),
            maxX: Math.max(bounds.maxX, connection.sourcePoint.x),
            minY: Math.min(bounds.minY, connection.sourcePoint.y),
            maxY: Math.max(bounds.maxY, connection.sourcePoint.y),
          }),
          {
            minX: Number.POSITIVE_INFINITY,
            maxX: Number.NEGATIVE_INFINITY,
            minY: Number.POSITIVE_INFINITY,
            maxY: Number.NEGATIVE_INFINITY,
          },
        )
        const repairSourceViaPoints = boundaryFirstFallback
          ? candidate.map
          : probe.viaPoints
        const distanceToFailedSourceBounds = (bus: PreparedBus) =>
          Math.min(
            ...bus.connections.map((connection) => {
              const point = repairSourceViaPoints.get(
                connection.connectionIndex,
              )
              if (!point) return Number.POSITIVE_INFINITY
              const dx = Math.max(
                failedSourceBounds.minX - point.x,
                0,
                point.x - failedSourceBounds.maxX,
              )
              const dy = Math.max(
                failedSourceBounds.minY - point.y,
                0,
                point.y - failedSourceBounds.maxY,
              )
              return Math.hypot(dx, dy)
            }),
          )
        const isEmbeddedSingletonNeighbor = (bus: PreparedBus) => {
          if (!leadingWideSingletonBuses.includes(bus)) return false
          const targetLayer = params.busLayerAssignments[bus.busId]
          return Boolean(
            targetLayer &&
              (isDenseSingletonEmbeddedInSingleLayerWideBus({
                singletonBus: bus,
                singletonTargetLayer: targetLayer,
                wideBuses: [probe.failedBus!],
              }) ||
                isDenseSingletonEmbeddedInMultiLayerWideBus({
                  singletonBus: bus,
                  singletonTargetLayer: targetLayer,
                  wideBuses: [probe.failedBus!],
                })),
          )
        }
        const neighboringBuses = initiallyMatchedBoundaryBuses
          .filter((bus) => bus !== probe.failedBus)
          .toSorted(
            (first, second) =>
              Number(isEmbeddedSingletonNeighbor(second)) -
                Number(isEmbeddedSingletonNeighbor(first)) ||
              distanceToFailedSourceBounds(first) -
                distanceToFailedSourceBounds(second) ||
              Number(second.preferredExit === probe.failedBus!.preferredExit) -
                Number(
                  first.preferredExit === probe.failedBus!.preferredExit,
                ) ||
              second.connections.length - first.connections.length,
          )
          .slice(0, 2)
        const repairedBoundaryMaps: Map<number, { x: number; y: number }>[] = []
        for (const neighbor of neighboringBuses) {
          const mutableBuses = [probe.failedBus, neighbor]
          const mutableConnectionIndexes = new Set(
            mutableBuses.flatMap((bus) =>
              bus.connections.map((connection) => connection.connectionIndex),
            ),
          )
          const fixedOtherBoundaryPoints = new Map<
            number,
            { x: number; y: number }
          >()
          for (const connectionIndex of boundaryConnectionIndexes) {
            if (mutableConnectionIndexes.has(connectionIndex)) continue
            const point = repairSourceViaPoints.get(connectionIndex)
            if (point) fixedOtherBoundaryPoints.set(connectionIndex, point)
          }

          const forcedSiteCountByConnection = new Map<number, number>()
          const forcedNeighborSites = getComponentDogboneViaSiteCandidates(
            [neighbor],
            jointMatchingRules,
          ).filter((site) => {
            const currentPoint = repairSourceViaPoints.get(site.connectionIndex)
            if (
              !currentPoint ||
              (Math.abs(currentPoint.x - site.point.x) <= 1e-9 &&
                Math.abs(currentPoint.y - site.point.y) <= 1e-9)
            ) {
              return false
            }
            const count =
              forcedSiteCountByConnection.get(site.connectionIndex) ?? 0
            if (count >= (boundaryFirstFallback ? 2 : 4)) return false
            forcedSiteCountByConnection.set(site.connectionIndex, count + 1)
            return true
          })
          for (const forcedSite of forcedNeighborSites) {
            const forcedPoints = new Map(fixedOtherBoundaryPoints)
            forcedPoints.set(forcedSite.connectionIndex, forcedSite.point)
            const forcedMap = matchComponentDogboneViaSites(
              initiallyMatchedBoundaryBuses,
              {
                ...jointMatchingRules,
                fixedViaPointsByConnectionIndex: forcedPoints,
              },
            )
            if (forcedMap) repairedBoundaryMaps.push(forcedMap)
          }
          repairedBoundaryMaps.push(
            ...matchComponentDogboneViaSiteAlternatives(
              initiallyMatchedBoundaryBuses,
              {
                ...jointMatchingRules,
                fixedViaPointsByConnectionIndex: fixedOtherBoundaryPoints,
              },
              4,
            ),
          )
        }

        const repairChildren: Array<{
          map: Map<number, { x: number; y: number }>
          depth: number
          parentPlanCount: number
          preferredRoutingOrder: DenseBoundaryRoutingOrderCandidate<PreparedBus>
        }> = []
        for (const repairedBoundaryMap of repairedBoundaryMaps) {
          const repairedFullMap = matchComponentDogboneViaSites(
            allJointMatchedBuses,
            {
              ...jointMatchingRules,
              fixedViaPointsByConnectionIndex: repairedBoundaryMap,
            },
          )
          if (!repairedFullMap) continue
          const signature = getBoundarySignature(repairedFullMap)
          if (seenBoundarySignatures.has(signature)) continue
          seenBoundarySignatures.add(signature)
          repairChildren.push({
            map: repairedFullMap,
            depth: candidate.depth + 1,
            parentPlanCount: probe.plans.length,
            preferredRoutingOrder: probe.routingOrder,
          })
          if (
            repairChildren.length +
              pendingJointMaps.length +
              probedJointOrderCount >=
            maximumRouteGuidedJointProbes
          ) {
            break
          }
        }
        if (repairChildren.length > 0) {
          pendingJointMaps.unshift(...repairChildren)
        }
      }
      if (!cheapJointPlans && bestCheapJointProbe) {
        jointViaPoints = bestCheapJointProbe.viaPoints
        cheapJointPlans = bestCheapJointProbe.plans
        selectedDenseBoundaryRoutingOrder = bestCheapJointProbe.routingOrder
      }
      let planeCapacityReplayCompletedBoundary = false
      if (
        fixedMapSearchPolicy.usePlaneCapacityReplay &&
        !boundaryFirstFallback &&
        planeBuses.length > 0 &&
        capacityReplayCandidates.length > 0
      ) {
        for (const replayCandidate of capacityReplayCandidates.toSorted(
          compareDenseJointProbes,
        )) {
          const repaired = repairTemplatePrefixForPlaneCapacity({
            templatePlans: replayCandidate.plans,
            candidateViaPoints: replayCandidate.viaPoints,
            routingOrder: replayCandidate.routingOrder.buses,
          })
          if (
            repaired.failedBus ||
            repaired.plans.length !==
              boundaryBuses.reduce(
                (count, bus) => count + bus.connections.length,
                0,
              )
          ) {
            continue
          }
          cheapJointPlans = repaired.plans
          jointViaPoints = repaired.viaPoints
          selectedDenseBoundaryRoutingOrder = replayCandidate.routingOrder
          planeCapacityReplayCompletedBoundary = true
          break
        }
      }
      let fixedViaPointsByConnectionIndex: ReadonlyMap<
        number,
        { x: number; y: number }
      > = jointViaPoints ?? seedViaPoints
      let matchedPlans: FanoutRoutePlan[] = cheapJointPlans ?? []
      let matchedRoutingSucceeded = true
      const getReservedVias = (
        bus: PreparedBus,
        viaPoints: ReadonlyMap<
          number,
          { x: number; y: number }
        > = fixedViaPointsByConnectionIndex,
      ) => {
        const currentConnectionNames = new Set(
          bus.connections.map((connection) => connection.connection.name),
        )
        return (
          boundaryFirstFallback
            ? boundaryBuses
            : [...boundaryBuses, ...planeBuses]
        ).flatMap((preparedBus) => {
          const targetLayer = params.busLayerAssignments[preparedBus.busId]
          if (!targetLayer) return []
          return preparedBus.connections.flatMap((connection) => {
            if (currentConnectionNames.has(connection.connection.name))
              return []
            const center = viaPoints.get(connection.connectionIndex)
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
      const routeMatchedBoundaryBus = (bus: PreparedBus): boolean => {
        const targetLayer = params.busLayerAssignments[bus.busId]
        if (!targetLayer) {
          return false
        }
        const initialBusBudget = Math.min(
          denseExpandedStateBudget.remaining,
          bus.connections.length <= 2 ? 720_000 : 1_500_000,
        )
        const busBudget = { remaining: initialBusBudget }
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
          viaMinimalOnly: true,
          fixedViaWindingOnly:
            fixedMapSearchPolicy.useFixedViaWindingOnly &&
            bus.connections.length > 2,
          cornerBandTargetTrackOffset: getCornerBandTargetTrackOffset(bus),
          ...(fixedMapSearchPolicy.useExpandedStateSearch
            ? { expandedStateBudget: busBudget }
            : {}),
        } as const
        let busPlans: FanoutRoutePlan[] | null =
          routeBusAlternatives(routeParams, 1)[0] ?? null
        let capacityRepairConsumedStates = 0
        let capacityAwareRouteSelected = false
        if (busPlans && fixedMapSearchPolicy.usePlaneCapacityReplay) {
          const baselineBusPlans = busPlans
          const capacityGroups = getNewlyBlockedPlaneCapacityGroups({
            acceptedPlans: matchedPlans,
            candidatePlans: busPlans,
          })
          if (capacityGroups && capacityGroups.length > 0) {
            const initialCapacityRepairBudget = Math.min(
              Math.max(
                0,
                denseExpandedStateBudget.remaining -
                  (initialBusBudget - busBudget.remaining),
              ),
              bus.connections.length <= 2 ? 720_000 : 1_500_000,
            )
            const capacityRepairBudget = {
              remaining: initialCapacityRepairBudget,
            }
            const capacityAwareAlternatives = routeBusAlternatives(
              {
                ...routeParams,
                fixedViaWindingOnly: false,
                softViaCapacityGroups: capacityGroups,
                ...(fixedMapSearchPolicy.useExpandedStateSearch
                  ? { expandedStateBudget: capacityRepairBudget }
                  : {}),
              },
              4,
            )
            capacityRepairConsumedStates +=
              initialCapacityRepairBudget - capacityRepairBudget.remaining
            busPlans = null
            for (const alternative of capacityAwareAlternatives) {
              const completedPlans = [...matchedPlans, ...alternative]
              const actualBoundaryViaPoints = getRoutedBoundaryViaPoints(
                completedPlans,
                fixedViaPointsByConnectionIndex,
              )
              const completeViaPoints =
                matchCompleteDogboneMapAroundBoundaryPlans({
                  plans: completedPlans,
                  boundaryViaPoints: actualBoundaryViaPoints,
                  preferredViaPoints: fixedViaPointsByConnectionIndex,
                })
              if (!completeViaPoints) continue
              busPlans = alternative
              fixedViaPointsByConnectionIndex = completeViaPoints
              capacityAwareRouteSelected = true
              break
            }
            // Adjacent one-segment plane dogbones are only a routing
            // preference. The final global matcher can assign clear
            // octilinear channel paths around the complete boundary topology,
            // so retain the geometrically valid boundary route when this
            // legacy local-capacity repair cannot preserve every direct site.
            busPlans ??= baselineBusPlans
          }
        }
        if (
          busPlans &&
          !capacityAwareRouteSelected &&
          bus.maxLengthSkew !== undefined
        ) {
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
          if (needsRouteDiversity) {
            const lowerSkewAlternative = routeBusAlternatives(
              routeParams,
              3,
            ).toSorted((first, second) => {
              const firstLengths = first.map((plan) => plan.length)
              const secondLengths = second.map((plan) => plan.length)
              return (
                Math.max(...firstLengths) -
                Math.min(...firstLengths) -
                (Math.max(...secondLengths) - Math.min(...secondLengths))
              )
            })[0]
            if (lowerSkewAlternative) {
              busPlans = lowerSkewAlternative
            }
          }
        }
        const consumedBusStates =
          initialBusBudget - busBudget.remaining + capacityRepairConsumedStates
        denseExpandedStateBudget.remaining -= consumedBusStates
        if (denseExpandedStateBudget.remaining <= 0) {
          denseExpandedStateBudget.exhausted = true
        }
        if (!busPlans) {
          return false
        }
        matchedPlans.push(...busPlans)
        if (matchedPlans.length > bestDensePartialPlans.length) {
          bestDensePartialPlans = [...matchedPlans]
        }
        return true
      }

      /**
       * A joint reservation for every future dogbone is too rigid in a dense
       * through-via field, but assigning each bus independently lets an early
       * narrow route consume the only escape site for a later byte lane. Route
       * the least-constrained narrow trunks first while reserving only one
       * corner byte bus. When a two-line trunk is reached, reserve the wide bus
       * whose source field contains it, then release each reservation as that
       * wide bus is routed. This keeps the search local while preserving the
       * two byte-lane corridors that make the complete topology possible.
       */
      function tryStagedNarrowFirstBoundary(this: FanoutSolver): {
        plans: FanoutRoutePlan[]
        viaPoints: Map<number, { x: number; y: number }>
      } | null {
        const getTargetTangent = (bus: PreparedBus): number => {
          const tangentAxis =
            bus.exitEdge === "left" || bus.exitEdge === "right" ? "y" : "x"
          return (
            bus.connections.reduce((sum, connection) => {
              const point = connection.exitTargetPoint ?? connection.targetPoint
              return sum + point[tangentAxis]
            }, 0) / bus.connections.length
          )
        }
        const isCornerBanded = (bus: PreparedBus): boolean =>
          Boolean(getCornerBandSide(bus.exitEdge, bus.preferredExit))
        const targetNarrowFirstOrder = boundaryBuses.toSorted(
          (first, second) => {
            const firstIsWide = first.connections.length > 2
            const secondIsWide = second.connections.length > 2
            if (firstIsWide !== secondIsWide) {
              return Number(firstIsWide) - Number(secondIsWide)
            }

            const firstIsBanded = isCornerBanded(first)
            const secondIsBanded = isCornerBanded(second)
            if (firstIsBanded !== secondIsBanded) {
              return Number(firstIsBanded) - Number(secondIsBanded)
            }

            if (!firstIsWide) {
              if (first.connections.length !== second.connections.length) {
                return firstIsBanded
                  ? second.connections.length - first.connections.length
                  : first.connections.length - second.connections.length
              }
              return firstIsBanded
                ? getTargetTangent(second) - getTargetTangent(first)
                : getTargetTangent(first) - getTargetTangent(second)
            }

            return getTargetTangent(first) - getTargetTangent(second)
          },
        )
        const isReflectedHorizontalExit = boundaryBuses.every(
          (bus) => bus.exitEdge === "left",
        )
        const stagedOrder = isReflectedHorizontalExit
          ? boundaryBuses.toSorted((first, second) => {
              const firstIsWide = first.connections.length > 2
              const secondIsWide = second.connections.length > 2
              if (firstIsWide !== secondIsWide) {
                return Number(firstIsWide) - Number(secondIsWide)
              }

              const getReflectedBandRank = (bus: PreparedBus): number => {
                const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
                if (firstIsWide) {
                  return side === undefined ? 0 : side === "maximum" ? 1 : 2
                }
                return side === "minimum" ? 0 : side === undefined ? 1 : 2
              }
              const bandRankDifference =
                getReflectedBandRank(first) - getReflectedBandRank(second)
              if (bandRankDifference !== 0) return bandRankDifference
              if (
                !firstIsWide &&
                !isCornerBanded(first) &&
                first.connections.length !== second.connections.length
              ) {
                return first.connections.length - second.connections.length
              }
              return getTargetTangent(second) - getTargetTangent(first)
            })
          : targetNarrowFirstOrder
        const wideBuses = stagedOrder.filter(
          (bus) => bus.connections.length > 2,
        )
        const initialReservationCandidates: Array<PreparedBus | null> =
          isReflectedHorizontalExit ? [null] : wideBuses.filter(isCornerBanded)
        if (initialReservationCandidates.length === 0) return null

        for (const initialReservedWideBus of initialReservationCandidates) {
          const stagedPlans: FanoutRoutePlan[] = []
          const stagedRoutedBuses: PreparedBus[] = []
          let stagedViaPoints = new Map<number, { x: number; y: number }>()
          const reservedWideBuses = new Set<PreparedBus>(
            initialReservedWideBus ? [initialReservedWideBus] : [],
          )
          let candidateSucceeded = true

          for (const bus of stagedOrder) {
            if (bus.connections.length === 2) {
              if (isReflectedHorizontalExit && !isCornerBanded(bus)) {
                for (const wideBus of wideBuses.filter(isCornerBanded)) {
                  if (!stagedRoutedBuses.includes(wideBus)) {
                    reservedWideBuses.add(wideBus)
                  }
                }
              }
              const containingWideBus = isReflectedHorizontalExit
                ? undefined
                : wideBuses.find(
                    (wideBus) =>
                      wideBus !== bus &&
                      !stagedRoutedBuses.includes(wideBus) &&
                      busSourceIsInsideWideBus(bus, wideBus),
                  )
              if (containingWideBus) {
                reservedWideBuses.add(containingWideBus)
              }
            }
            reservedWideBuses.delete(bus)
            const jointlyReservedFutureBuses = wideBuses.filter(
              (wideBus) =>
                reservedWideBuses.has(wideBus) &&
                !stagedRoutedBuses.includes(wideBus),
            )
            const blockingSegments = stagedPlans.flatMap((plan) =>
              plan.segments.map((segment) => ({
                connectionIndex: plan.connectionIndex,
                segment,
              })),
            )
            const viaPointAlternatives =
              matchComponentDogboneViaSiteAlternatives(
                [...stagedRoutedBuses, bus, ...jointlyReservedFutureBuses],
                {
                  viaDiameter: this.config.viaDiameter,
                  viaHoleDiameter: this.config.viaHoleDiameter,
                  traceWidth: this.config.traceWidth,
                  clearance: this.config.clearance,
                  maximumSearchStates: maximumDenseDogboneSearchStates,
                  fixedViaPointsByConnectionIndex: stagedViaPoints,
                  blockingSegments,
                },
                16,
              )
            const targetLayer = params.busLayerAssignments[bus.busId]
            if (!targetLayer || viaPointAlternatives.length === 0) {
              candidateSucceeded = false
              break
            }

            let selected:
              | {
                  plans: FanoutRoutePlan[]
                  viaPoints: Map<number, { x: number; y: number }>
                }
              | undefined
            for (const candidateViaPoints of viaPointAlternatives) {
              if (denseExpandedStateBudget.remaining <= 0) {
                denseExpandedStateBudget.exhausted = true
                break
              }
              const initialBusBudget = Math.min(
                denseExpandedStateBudget.remaining,
                bus.connections.length <= 2
                  ? 720_000
                  : isReflectedHorizontalExit
                    ? 6_000_000
                    : 1_500_000,
              )
              const busBudget = { remaining: initialBusBudget }
              const reservedVias = jointlyReservedFutureBuses.flatMap(
                (futureBus) => {
                  const futureTargetLayer =
                    params.busLayerAssignments[futureBus.busId]
                  if (!futureTargetLayer) return []
                  return futureBus.connections.flatMap((connection) => {
                    const center = candidateViaPoints.get(
                      connection.connectionIndex,
                    )
                    return center
                      ? [
                          {
                            connectionName: connection.connection.name,
                            via: {
                              center,
                              diameter: this.config.viaDiameter,
                              spanLayers: getViaSpanLayers({
                                fromLayer: connection.sourceLayer,
                                toLayer: futureTargetLayer,
                                layerNames: this.config.layerNames,
                                allowBlindAndBuriedVias: false,
                              }),
                            },
                          },
                        ]
                      : []
                  })
                },
              )
              const candidatePlans = routeBusAlternatives(
                {
                  srj: this.routingSrj,
                  bus,
                  targetLayer,
                  acceptedPlans: stagedPlans,
                  layerNames: this.config.layerNames,
                  traceWidth: this.config.traceWidth,
                  viaDiameter: this.config.viaDiameter,
                  viaHoleDiameter: this.config.viaHoleDiameter,
                  clearance: this.config.clearance,
                  compactBusTracks: this.config.compactBusTracks,
                  allowBlindAndBuriedVias: false,
                  allowSameNetMerges: this.config.allowSameNetMerges,
                  staticClearanceCache: this.routeStaticClearanceCache,
                  fixedViaPointsByConnectionIndex: candidateViaPoints,
                  reservedVias,
                  viaMinimalOnly: !isReflectedHorizontalExit,
                  fixedViaWindingOnly:
                    fixedMapSearchPolicy.useFixedViaWindingOnly &&
                    !isReflectedHorizontalExit,
                  ...(fixedMapSearchPolicy.useExpandedStateSearch
                    ? { expandedStateBudget: busBudget }
                    : {}),
                },
                1,
              )[0]
              denseExpandedStateBudget.remaining -=
                initialBusBudget - busBudget.remaining
              if (candidatePlans) {
                selected = {
                  plans: candidatePlans,
                  viaPoints: candidateViaPoints,
                }
                break
              }
            }
            if (!selected) {
              candidateSucceeded = false
              break
            }

            stagedPlans.push(...selected.plans)
            stagedRoutedBuses.push(bus)
            stagedViaPoints = new Map(stagedViaPoints)
            for (const plan of selected.plans) {
              const point =
                plan.via?.center ?? selected.viaPoints.get(plan.connectionIndex)
              if (point) {
                stagedViaPoints.set(plan.connectionIndex, point)
              }
            }
            if (stagedPlans.length > bestDensePartialPlans.length) {
              bestDensePartialPlans = [...stagedPlans]
            }
          }

          if (
            candidateSucceeded &&
            stagedPlans.length ===
              boundaryBuses.reduce(
                (count, bus) => count + bus.connections.length,
                0,
              ) &&
            fanoutPlansAreClear({
              plans: stagedPlans,
              srj: this.routingSrj,
              sharedBoundary: boundaryBuses[0]!.sharedBoundary,
              clearance: this.config.clearance,
              allowBlindAndBuriedVias: false,
              allowSameNetMerges: this.config.allowSameNetMerges,
            })
          ) {
            return { plans: stagedPlans, viaPoints: stagedViaPoints }
          }
        }
        return null
      }

      const tryCompleteNarrowSameLayerBoundaryBundle = (
        options: {
          maximumStates?: number
          chargeDenseBudget?: boolean
          preservePlaneCapacity?: boolean
        } = {},
      ): boolean => {
        const {
          maximumStates = 2_500_000,
          chargeDenseBudget = true,
          preservePlaneCapacity = false,
        } = options
        const routedBusIds = new Set(matchedPlans.map((plan) => plan.busId))
        const unroutedBoundaryBuses = boundaryBuses.filter(
          (bus) => !routedBusIds.has(bus.busId),
        )
        if (unroutedBoundaryBuses.length === 0) return false
        for (const seedBus of unroutedBoundaryBuses) {
          const targetLayer = params.busLayerAssignments[seedBus.busId]
          const exitEdge = seedBus.exitEdge
          if (!targetLayer || !exitEdge) continue
          const groupedBuses = boundaryBuses.filter(
            (bus) =>
              bus.componentId === seedBus.componentId &&
              bus.exitEdge === exitEdge &&
              bus.connections.length <= 2 &&
              busUsesCoordinatedWinding(bus) &&
              params.busLayerAssignments[bus.busId] === targetLayer &&
              bus.connections.every(
                (connection) => connection.sourceLayer !== targetLayer,
              ),
          )
          const groupedConnectionCount = groupedBuses.reduce(
            (count, bus) => count + bus.connections.length,
            0,
          )
          if (
            groupedBuses.length < 3 ||
            groupedConnectionCount < 5 ||
            groupedConnectionCount > 12
          ) {
            continue
          }
          const groupedBusIds = new Set(groupedBuses.map((bus) => bus.busId))
          if (
            unroutedBoundaryBuses.some(
              (bus) => !groupedBusIds.has(bus.busId),
            ) ||
            groupedBuses.some((bus) =>
              bus.connections.some(
                (connection) =>
                  !fixedViaPointsByConnectionIndex.has(
                    connection.connectionIndex,
                  ),
              ),
            )
          ) {
            continue
          }

          const originalBusByConnectionIndex = new Map(
            groupedBuses.flatMap((bus) =>
              bus.connections.map(
                (connection) => [connection.connectionIndex, bus] as const,
              ),
            ),
          )
          const boundaryExitDirection = getDirectionForExitEdge(exitEdge)
          const boundaryDirection =
            exitEdge === "left" || exitEdge === "right"
              ? "vertical"
              : "horizontal"
          const groupedConnections = groupedBuses
            .flatMap((bus) => bus.connections)
            .toSorted((first, second) => {
              const firstTrack =
                boundaryDirection === "vertical"
                  ? first.targetPoint.y
                  : first.targetPoint.x
              const secondTrack =
                boundaryDirection === "vertical"
                  ? second.targetPoint.y
                  : second.targetPoint.x
              return (
                firstTrack - secondTrack ||
                first.connectionIndex - second.connectionIndex
              )
            })
          const syntheticBus: PreparedBus = {
            ...seedBus,
            busId: groupedBuses.map((bus) => bus.busId).join("+"),
            maxLengthSkew: undefined,
            allowedLayers: [targetLayer],
            routableEscapeLayers: [targetLayer],
            connections: groupedConnections,
          }
          const acceptedPlans = matchedPlans.filter(
            (plan) => !groupedBusIds.has(plan.busId),
          )
          const initialBundleBudget = chargeDenseBudget
            ? Math.min(denseExpandedStateBudget.remaining, maximumStates)
            : maximumStates
          const bundleBudget = { remaining: initialBundleBudget }
          const bundleRouteBaseParams = {
            srj: this.routingSrj,
            bus: syntheticBus,
            targetLayer,
            acceptedPlans,
            layerNames: this.config.layerNames,
            traceWidth: this.config.traceWidth,
            viaDiameter: this.config.viaDiameter,
            viaHoleDiameter: this.config.viaHoleDiameter,
            clearance: this.config.clearance,
            allowBlindAndBuriedVias: false,
            allowSameNetMerges: this.config.allowSameNetMerges,
            maximumRouteOrderAttempts: 6,
            gridStepDivisor:
              Math.min(syntheticBus.pitchX, syntheticBus.pitchY) -
                2 *
                  (this.config.viaDiameter / 2 +
                    this.config.traceWidth / 2 +
                    this.config.clearance) <
              this.config.traceWidth + this.config.clearance
                ? (2 as const)
                : (1 as const),
            preferTargetDirectedLaneBias: true,
          } as const
          // Preserve the literal connection-to-target assignment as a
          // dedicated first attempt. Building remapped candidates around it
          // changed the bounded search enough to lose a proven dense north
          // topology even though the first candidate appeared equivalent.
          const identityTerminals = groupedConnections.map((connection) => ({
            connection,
            viaPoint: fixedViaPointsByConnectionIndex.get(
              connection.connectionIndex,
            )!,
            exitPoint: projectPointToBoundaryExitEdge({
              point: connection.targetPoint,
              exitEdge,
              boundary: seedBus.sharedBoundary,
            }),
          }))
          // Source-topology remaps remain useful for reflected exits, but they
          // are constructed only after the identity attempt fails and route
          // from their own bounded pool.
          const bundleRouteResult = routeIdentityTerminalsBeforeRemaps({
            identityTerminals,
            identityBudget: bundleBudget,
            createRemapBudget: (identityConsumedStates) => ({
              remaining: chargeDenseBudget
                ? Math.min(
                    Math.max(
                      0,
                      denseExpandedStateBudget.remaining -
                        identityConsumedStates,
                    ),
                    maximumStates,
                  )
                : maximumStates,
            }),
            getRemappedTerminalCandidates: () => {
              const orderedExitPoints = groupedConnections
                .map((connection) =>
                  projectPointToBoundaryExitEdge({
                    point: connection.targetPoint,
                    exitEdge,
                    boundary: seedBus.sharedBoundary,
                  }),
                )
                .toSorted((first, second) => {
                  const firstTrack =
                    boundaryDirection === "vertical" ? first.y : first.x
                  const secondTrack =
                    boundaryDirection === "vertical" ? second.y : second.x
                  return firstTrack - secondTrack
                })
              const identityOrderKey = groupedConnections
                .map((connection) => connection.connectionIndex)
                .join(",")
              const remappedConnectionOrders =
                getPrioritizedSourceTopologyConnectionOrders(
                  syntheticBus,
                  boundaryExitDirection,
                ).filter(
                  (order, index, orders) =>
                    order
                      .map((connection) => connection.connectionIndex)
                      .join(",") !== identityOrderKey &&
                    orders.findIndex(
                      (candidate) =>
                        candidate
                          .map((connection) => connection.connectionIndex)
                          .join(",") ===
                        order
                          .map((connection) => connection.connectionIndex)
                          .join(","),
                    ) === index,
                )
              return remappedConnectionOrders.map((order) => {
                const exitPointByConnectionIndex =
                  assignRemappedExitPointsPreservingBusTargetOrder({
                    sourceOrderedConnections: order,
                    groupedBuses,
                    orderedExitPoints,
                    tangentAxis: boundaryDirection === "vertical" ? "y" : "x",
                  })
                return groupedConnections.map((connection) => ({
                  connection,
                  viaPoint: fixedViaPointsByConnectionIndex.get(
                    connection.connectionIndex,
                  )!,
                  exitPoint: exitPointByConnectionIndex.get(
                    connection.connectionIndex,
                  )!,
                }))
              })
            },
            route: (terminals, expandedStateBudget) =>
              routeViaMinimalWindingAlternatives(
                {
                  ...bundleRouteBaseParams,
                  terminals,
                  expandedStateBudget,
                },
                1,
              ),
          })
          const selectedTerminals = bundleRouteResult.selectedTerminals
          let groupedPlanAlternatives = bundleRouteResult.alternatives
          const bundleConsumedStates = bundleRouteResult.consumedStates
          const bundleRouteParams = {
            ...bundleRouteBaseParams,
            terminals: selectedTerminals,
          }
          let capacityRepairConsumedStates = 0
          let capacityAwareBundle = false
          const baselineGroupedPlans = groupedPlanAlternatives[0]
          if (baselineGroupedPlans && preservePlaneCapacity) {
            const capacityGroups = getNewlyBlockedPlaneCapacityGroups({
              acceptedPlans,
              candidatePlans: baselineGroupedPlans,
            })
            if (capacityGroups === null) {
              groupedPlanAlternatives = []
            } else if (capacityGroups.length > 0) {
              const baselineConsumedStates = bundleConsumedStates
              const initialCapacityRepairBudget = chargeDenseBudget
                ? Math.min(
                    Math.max(
                      0,
                      denseExpandedStateBudget.remaining -
                        baselineConsumedStates,
                    ),
                    maximumStates,
                  )
                : maximumStates
              const capacityRepairBudget = {
                remaining: initialCapacityRepairBudget,
              }
              groupedPlanAlternatives = routeViaMinimalWindingAlternatives(
                {
                  ...bundleRouteParams,
                  maximumRouteOrderAttempts: 24,
                  softViaCapacityGroups: capacityGroups,
                  expandedStateBudget: capacityRepairBudget,
                },
                4,
              )
              capacityRepairConsumedStates =
                initialCapacityRepairBudget - capacityRepairBudget.remaining
              capacityAwareBundle = true
            }
          }
          if (chargeDenseBudget) {
            denseExpandedStateBudget.remaining -=
              bundleConsumedStates + capacityRepairConsumedStates
          }
          for (const groupedPlans of groupedPlanAlternatives) {
            const relabeledPlans = groupedPlans.map((plan) => {
              const originalBus = originalBusByConnectionIndex.get(
                plan.connectionIndex,
              )!
              return {
                ...plan,
                busId: originalBus.busId,
                direction: originalBus.direction,
                exitEdge: originalBus.exitEdge,
                cornerBandSide: getCornerBandSide(
                  originalBus.exitEdge,
                  originalBus.preferredExit,
                ),
                termination: originalBus.termination,
              }
            })
            const completedPlans = [...acceptedPlans, ...relabeledPlans]
            if (
              completedPlans.length !==
                boundaryBuses.reduce(
                  (count, bus) => count + bus.connections.length,
                  0,
                ) ||
              !fanoutPlansAreClear({
                plans: completedPlans,
                srj: this.routingSrj,
                sharedBoundary: syntheticBus.sharedBoundary,
                clearance: this.config.clearance,
                allowBlindAndBuriedVias: false,
                allowSameNetMerges: this.config.allowSameNetMerges,
              })
            ) {
              continue
            }
            if (capacityAwareBundle) {
              const actualBoundaryViaPoints = getRoutedBoundaryViaPoints(
                completedPlans,
                fixedViaPointsByConnectionIndex,
              )
              const completeViaPoints =
                matchCompleteDogboneMapAroundBoundaryPlans({
                  plans: completedPlans,
                  boundaryViaPoints: actualBoundaryViaPoints,
                  preferredViaPoints: fixedViaPointsByConnectionIndex,
                })
              if (!completeViaPoints) continue
              fixedViaPointsByConnectionIndex = completeViaPoints
            }
            matchedPlans = completedPlans
            if (matchedPlans.length > bestDensePartialPlans.length) {
              bestDensePartialPlans = [...matchedPlans]
            }
            return true
          }
        }
        return false
      }

      const tryRepairWideBoundarySkewWithDogboneSites = (): boolean => {
        const baselinePlans = matchedPlans
        const baselineViaPoints = fixedViaPointsByConnectionIndex
        const constrainedWideBuses = boundaryBuses
          .flatMap((bus) => {
            if (
              bus.maxLengthSkew === undefined ||
              bus.connections.length <= 2
            ) {
              return []
            }
            const busPlans = baselinePlans.filter(
              (plan) => plan.busId === bus.busId,
            )
            if (busPlans.length !== bus.connections.length) return []
            const lengths = busPlans.map((plan) => plan.length)
            const rawSkew = Math.max(...lengths) - Math.min(...lengths)
            if (
              !shouldSearchAdditionalBoundaryRouteTopologies({
                boundaryBusCount: boundaryBuses.length,
                connectionCount: bus.connections.length,
                rawSkew,
                maximumSkew: bus.maxLengthSkew,
              })
            ) {
              return []
            }
            return [
              {
                bus,
                normalizedExcess:
                  (rawSkew - bus.maxLengthSkew) / bus.maxLengthSkew,
              },
            ]
          })
          .toSorted(
            (first, second) =>
              second.normalizedExcess - first.normalizedExcess ||
              first.bus.busId.localeCompare(second.bus.busId),
          )
          .map(({ bus }) => bus)

        for (const bus of constrainedWideBuses) {
          const targetLayer = params.busLayerAssignments[bus.busId]
          if (!targetLayer) continue
          const maximumSkew = bus.maxLengthSkew!
          const reroutableNarrowGroups = new Map<string, PreparedBus[]>()
          for (const candidate of boundaryBuses) {
            const candidateTargetLayer =
              params.busLayerAssignments[candidate.busId]
            if (
              candidate === bus ||
              !candidateTargetLayer ||
              !candidate.exitEdge ||
              candidate.connections.length > 2 ||
              !busUsesCoordinatedWinding(candidate) ||
              candidate.connections.some(
                (connection) => connection.sourceLayer === candidateTargetLayer,
              )
            ) {
              continue
            }
            const key = `${candidate.componentId}:${candidate.exitEdge}:${candidateTargetLayer}`
            const group = reroutableNarrowGroups.get(key) ?? []
            group.push(candidate)
            reroutableNarrowGroups.set(key, group)
          }
          const reroutableNarrowBusIds = new Set(
            [...reroutableNarrowGroups.values()]
              .filter((group) => {
                const connectionCount = group.reduce(
                  (count, candidate) => count + candidate.connections.length,
                  0,
                )
                return (
                  group.length >= 3 &&
                  connectionCount >= 5 &&
                  connectionCount <= 12
                )
              })
              .flatMap((group) => group.map((candidate) => candidate.busId)),
          )
          if (reroutableNarrowBusIds.size === 0) continue

          const mutableConnectionIndexes = new Set(
            bus.connections.map((connection) => connection.connectionIndex),
          )
          const fixedOtherViaPoints = new Map(
            [...baselineViaPoints].filter(
              ([connectionIndex]) =>
                !mutableConnectionIndexes.has(connectionIndex),
            ),
          )
          const siteAlternatives = matchComponentDogboneViaSiteAlternatives(
            [...planeBuses, ...boundaryBuses],
            {
              ...jointMatchingRules,
              maximumSearchStates: 32,
              fixedViaPointsByConnectionIndex: fixedOtherViaPoints,
            },
            16,
          )
          const baselineSiteSignature = JSON.stringify(
            bus.connections.map((connection) =>
              baselineViaPoints.get(connection.connectionIndex),
            ),
          )
          const seenSiteSignatures = new Set<string>()
          const fixedOtherTopologyPlans = baselinePlans.filter(
            (plan) =>
              plan.busId !== bus.busId &&
              !reroutableNarrowBusIds.has(plan.busId),
          )
          // A complete dogbone map can need more than 1.5M winding states
          // before its first clear wide-bus topology appears in a dense BGA.
          // Keep the search bounded per map, but give every one of the 16
          // jointly matched site maps the same budget used by the focused
          // length-aware dogbone regression.
          const maximumStatesPerSiteReroute = 2_000_000
          const maximumSiteRerouteStates = 16 * maximumStatesPerSiteReroute
          const siteRerouteBudget = {
            remaining: maximumSiteRerouteStates,
          }

          for (const candidateViaPoints of siteAlternatives) {
            const signature = JSON.stringify(
              bus.connections.map((connection) =>
                candidateViaPoints.get(connection.connectionIndex),
              ),
            )
            if (
              signature === baselineSiteSignature ||
              seenSiteSignatures.has(signature)
            ) {
              continue
            }
            seenSiteSignatures.add(signature)
            if (siteRerouteBudget.remaining <= 0) break
            const candidateBudget = {
              remaining: Math.min(
                siteRerouteBudget.remaining,
                maximumStatesPerSiteReroute,
              ),
            }
            const initialCandidateBudget = candidateBudget.remaining
            const candidatePlans = routeBusAlternatives(
              {
                srj: this.routingSrj,
                bus,
                targetLayer,
                acceptedPlans: fixedOtherTopologyPlans,
                layerNames: this.config.layerNames,
                traceWidth: this.config.traceWidth,
                viaDiameter: this.config.viaDiameter,
                viaHoleDiameter: this.config.viaHoleDiameter,
                clearance: this.config.clearance,
                compactBusTracks: this.config.compactBusTracks,
                allowBlindAndBuriedVias: false,
                allowSameNetMerges: this.config.allowSameNetMerges,
                staticClearanceCache: this.routeStaticClearanceCache,
                fixedViaPointsByConnectionIndex: candidateViaPoints,
                reservedVias: getReservedVias(bus, candidateViaPoints),
                viaMinimalOnly: true,
                fixedViaWindingOnly:
                  fixedMapSearchPolicy.useFixedViaWindingOnly,
                cornerBandTargetTrackOffset:
                  getCornerBandTargetTrackOffset(bus),
                expandedStateBudget: candidateBudget,
              },
              1,
            )[0]
            siteRerouteBudget.remaining -=
              initialCandidateBudget - candidateBudget.remaining
            if (!candidatePlans) continue
            const lengths = candidatePlans.map((plan) => plan.length)
            if (
              Math.max(...lengths) - Math.min(...lengths) >
              maximumSkew + 1e-6
            ) {
              continue
            }

            matchedPlans = [...fixedOtherTopologyPlans, ...candidatePlans]
            fixedViaPointsByConnectionIndex = candidateViaPoints
            if (
              tryCompleteNarrowSameLayerBoundaryBundle({
                maximumStates: 500_000,
                chargeDenseBudget: false,
              }) &&
              fanoutPlansAreClear({
                plans: matchedPlans,
                srj: this.routingSrj,
                sharedBoundary: bus.sharedBoundary,
                clearance: this.config.clearance,
                allowBlindAndBuriedVias: false,
                allowSameNetMerges: this.config.allowSameNetMerges,
              })
            ) {
              const lengthResult = matchBusPlanLengths({
                plans: matchedPlans,
                preparedBuses: this.preparedBuses,
                inputSrj: this.inputSrj,
                sharedBoundary: this.getValidationBoundary(),
                clearance: this.config.clearance,
                allowBlindAndBuriedVias: false,
                allowSameNetMerges: this.config.allowSameNetMerges,
                allowMatchingInsideDenseBounds: true,
              })
              if (lengthResult.plans) {
                matchedPlans = lengthResult.plans
                return true
              }
            }
            matchedPlans = baselinePlans
            fixedViaPointsByConnectionIndex = baselineViaPoints
          }
        }
        matchedPlans = baselinePlans
        fixedViaPointsByConnectionIndex = baselineViaPoints
        return false
      }

      const boundaryFirstBundleCompleted =
        boundaryFirstFallback &&
        !planeCapacityReplayCompletedBoundary &&
        tryCompleteNarrowSameLayerBoundaryBundle({
          maximumStates: 2_500_000,
          preservePlaneCapacity: false,
        })
      if (
        boundaryFirstBundleCompleted ||
        tryCompleteNarrowSameLayerBoundaryBundle({ maximumStates: 200_000 })
      ) {
        tryRepairWideBoundarySkewWithDogboneSites()
      }
      // Once every boundary signal is routed, preserve that complete topology.
      // Plane drops are assigned globally below with octilinear channel paths;
      // rewriting an already-clear signal template merely to retain adjacent
      // one-segment dogbones is both unnecessarily restrictive and expensive.

      const cheaplyRoutedBusIds = new Set(
        matchedPlans.map((plan) => plan.busId),
      )
      const routedBoundaryBuses =
        selectedDenseBoundaryRoutingOrder.buses.filter((bus) =>
          cheaplyRoutedBusIds.has(bus.busId),
        )
      const remainingBoundaryBuses =
        selectedDenseBoundaryRoutingOrder.buses.filter(
          (bus) => !cheaplyRoutedBusIds.has(bus.busId),
        )
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
          const candidateHasFixedViaPoints = candidateBus.connections.every(
            (connection) =>
              fixedViaPointsByConnectionIndex.has(connection.connectionIndex),
          )
          const extendedViaPoints =
            jointViaPoints && candidateHasFixedViaPoints
              ? // The joint map is deliberately kept intact so getReservedVias()
                // blocks every already-reserved future through-barrel during A*.
                // Provisional singleton and plane dogbones are rematched later.
                new Map(fixedViaPointsByConnectionIndex)
              : matchComponentDogboneViaSites(
                  [...routedBoundaryBuses, candidateBus],
                  {
                    viaDiameter: this.config.viaDiameter,
                    viaHoleDiameter: this.config.viaHoleDiameter,
                    traceWidth: this.config.traceWidth,
                    clearance: this.config.clearance,
                    maximumSearchStates: maximumDenseDogboneSearchStates,
                    preferredBoundaryPerpendicularSideByBusId,
                    preferBoundaryOutwardByBusId,
                    fixedViaPointsByConnectionIndex:
                      fixedViaPointsByConnectionIndex,
                    blockingSegments,
                    canShareCopper,
                  },
                )
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
              [...routedBoundaryBuses, candidateBus, laterBus],
              {
                viaDiameter: this.config.viaDiameter,
                viaHoleDiameter: this.config.viaHoleDiameter,
                traceWidth: this.config.traceWidth,
                clearance: this.config.clearance,
                maximumSearchStates: maximumDenseDogboneSearchStates,
                preferredBoundaryPerpendicularSideByBusId,
                preferBoundaryOutwardByBusId,
                fixedViaPointsByConnectionIndex: extendedViaPoints,
                blockingSegments,
                canShareCopper,
              },
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
          const candidateFixedViaPointAlternatives = [candidateFixedViaPoints]
          if (candidateHasFixedViaPoints) {
            const candidateConnectionIndexes = new Set(
              candidateBus.connections.map(
                (connection) => connection.connectionIndex,
              ),
            )
            const fixedOtherBoundaryViaPoints = new Map(
              [...fixedViaPointsByConnectionIndex].filter(
                ([connectionIndex]) =>
                  !candidateConnectionIndexes.has(connectionIndex),
              ),
            )
            const rematchedAlternatives =
              matchComponentDogboneViaSiteAlternatives(
                boundaryBuses,
                {
                  ...jointMatchingRules,
                  fixedViaPointsByConnectionIndex: fixedOtherBoundaryViaPoints,
                  blockingSegments,
                },
                8,
              )
            const seenCandidateViaSignatures = new Set(
              candidateFixedViaPointAlternatives.map((points) =>
                JSON.stringify(
                  candidateBus.connections.map((connection) =>
                    points.get(connection.connectionIndex),
                  ),
                ),
              ),
            )
            for (const alternative of rematchedAlternatives) {
              const signature = JSON.stringify(
                candidateBus.connections.map((connection) =>
                  alternative.get(connection.connectionIndex),
                ),
              )
              if (seenCandidateViaSignatures.has(signature)) continue
              seenCandidateViaSignatures.add(signature)
              candidateFixedViaPointAlternatives.push(alternative)
            }
          }
          for (const candidateViaPoints of candidateFixedViaPointAlternatives) {
            fixedViaPointsByConnectionIndex = candidateViaPoints
            if (routeMatchedBoundaryBus(candidateBus)) {
              const candidateLeavesAFeasibleExtension =
                laterBuses.length === 0 ||
                (laterBuses.length === 1
                  ? (() => {
                      const lookaheadPlanCount = matchedPlans.length
                      const lookaheadViaPoints = fixedViaPointsByConnectionIndex
                      const laterBusRoutes = routeMatchedBoundaryBus(
                        laterBuses[0]!,
                      )
                      matchedPlans.splice(lookaheadPlanCount)
                      fixedViaPointsByConnectionIndex = lookaheadViaPoints
                      return laterBusRoutes
                    })()
                  : laterBuses.some((laterBus) => {
                      const lookaheadBlockingSegments = matchedPlans.flatMap(
                        (plan) =>
                          plan.segments.map((segment) => ({
                            connectionIndex: plan.connectionIndex,
                            segment,
                          })),
                      )
                      return Boolean(
                        matchComponentDogboneViaSites(
                          [...routedBoundaryBuses, candidateBus, laterBus],
                          {
                            viaDiameter: this.config.viaDiameter,
                            viaHoleDiameter: this.config.viaHoleDiameter,
                            traceWidth: this.config.traceWidth,
                            clearance: this.config.clearance,
                            maximumSearchStates:
                              maximumDenseDogboneSearchStates,
                            preferredBoundaryPerpendicularSideByBusId,
                            preferBoundaryOutwardByBusId,
                            fixedViaPointsByConnectionIndex:
                              fixedViaPointsByConnectionIndex,
                            blockingSegments: lookaheadBlockingSegments,
                            canShareCopper,
                          },
                        ),
                      )
                    }))
              if (candidateLeavesAFeasibleExtension) {
                selectedBusIndex = candidateIndex
                routedBoundaryBuses.push(candidateBus)
                break
              }
              matchedPlans.splice(previousPlanCount)
            }
            fixedViaPointsByConnectionIndex = previousFixedViaPoints
          }
          if (selectedBusIndex >= 0) break
          fixedViaPointsByConnectionIndex = previousFixedViaPoints
        }
        if (selectedBusIndex < 0) {
          matchedRoutingSucceeded = false
          break
        }
        remainingBoundaryBuses.splice(selectedBusIndex, 1)
      }
      if (
        !matchedRoutingSucceeded &&
        !stagedBoundaryAttempted &&
        fixedMapSearchPolicy.useExpandedStateSearch
      ) {
        const stagedBoundaryResult = tryStagedNarrowFirstBoundary.call(this)
        if (stagedBoundaryResult) {
          matchedPlans = stagedBoundaryResult.plans
          fixedViaPointsByConnectionIndex = stagedBoundaryResult.viaPoints
          matchedRoutingSucceeded = true
          remainingBoundaryBuses.splice(0)
        }
      }
      let feasibleDirectViaPoints: Map<
        number,
        { x: number; y: number }
      > | null = null
      let feasibleViaPaths: Map<number, ComponentDogboneViaPath> | null = null
      if (matchedRoutingSucceeded) {
        const getPlanGeometryKey = (
          plans: readonly FanoutRoutePlan[],
        ): string =>
          JSON.stringify(
            plans
              .map((plan) => ({
                connectionIndex: plan.connectionIndex,
                via: plan.via ? [plan.via.center.x, plan.via.center.y] : null,
                segments: plan.segments.map((segment) => [
                  segment.layer,
                  segment.width,
                  segment.start.x,
                  segment.start.y,
                  segment.end.x,
                  segment.end.y,
                ]),
              }))
              .toSorted(
                (first, second) =>
                  first.connectionIndex - second.connectionIndex,
              ),
          )
        const feasibleViaPathsByPlanGeometry = new Map<
          string,
          Map<number, ComponentDogboneViaPath>
        >()
        const getPreferredViaPoints = () =>
          feasibleDirectViaPoints ??
          (feasibleViaPaths
            ? new Map(
                [...feasibleViaPaths].map(
                  ([connectionIndex, assignment]) =>
                    [connectionIndex, assignment.point] as const,
                ),
              )
            : fixedViaPointsByConnectionIndex)
        const matchCompletionAroundPlans = (
          candidatePlans: readonly FanoutRoutePlan[],
        ): DenseDogboneCompletionAssignment | null =>
          matchDenseDogboneCompletionDirectFirst({
            matchDirect: () =>
              matchCompleteDogboneMapAroundBoundaryPlans({
                plans: candidatePlans,
                boundaryViaPoints: fixedViaPointsByConnectionIndex,
                preferredViaPoints: getPreferredViaPoints(),
              }),
            ...(fixedMapSearchPolicy.usePathAwareJointPlaneReservation
              ? {
                  matchPaths: () => {
                    const geometryKey = getPlanGeometryKey(candidatePlans)
                    let candidateViaPaths =
                      feasibleViaPathsByPlanGeometry.get(geometryKey) ?? null
                    if (!candidateViaPaths && feasibleViaPaths) {
                      candidateViaPaths =
                        matchCompleteDogbonePathsAroundBoundaryPlans({
                          plans: candidatePlans,
                          boundaryViaPoints: fixedViaPointsByConnectionIndex,
                          fixedViaPaths: feasibleViaPaths,
                        })
                    }
                    candidateViaPaths ??=
                      matchCompleteDogbonePathsAroundBoundaryPlans({
                        plans: candidatePlans,
                        boundaryViaPoints: fixedViaPointsByConnectionIndex,
                        preferredViaPoints: getPreferredViaPoints(),
                        preferredViaPaths: feasibleViaPaths ?? undefined,
                      })
                    if (candidateViaPaths) {
                      feasibleViaPathsByPlanGeometry.set(
                        geometryKey,
                        candidateViaPaths,
                      )
                    }
                    return candidateViaPaths
                  },
                }
              : {}),
          })
        const matchedLengthResult = matchBusPlanLengths({
          plans: matchedPlans,
          preparedBuses: this.preparedBuses,
          inputSrj: this.inputSrj,
          sharedBoundary: this.getValidationBoundary(),
          clearance: this.config.clearance,
          allowBlindAndBuriedVias: false,
          allowSameNetMerges: this.config.allowSameNetMerges,
          allowMatchingInsideDenseBounds: true,
          ...(boundaryFirstBundleCompleted
            ? {}
            : {
                candidatePlansAreFeasible: (candidatePlans) => {
                  const completion = matchCompletionAroundPlans(candidatePlans)
                  if (!completion) return false
                  if (completion.kind === "direct") {
                    feasibleDirectViaPoints = completion.viaPoints
                    feasibleViaPaths = null
                  } else {
                    feasibleDirectViaPoints = null
                    feasibleViaPaths = completion.viaPaths
                  }
                  return true
                },
              }),
        })
        if (matchedLengthResult.plans) {
          const completion = matchCompletionAroundPlans(
            matchedLengthResult.plans,
          )
          if (!completion) {
            matchedRoutingSucceeded = false
          } else if (completion.kind === "direct") {
            matchedPlans = matchedLengthResult.plans
            feasibleDirectViaPoints = completion.viaPoints
            feasibleViaPaths = null
            fixedViaPointsByConnectionIndex = completion.viaPoints
          } else {
            matchedPlans = matchedLengthResult.plans
            feasibleDirectViaPoints = null
            feasibleViaPaths = completion.viaPaths
            fixedViaPointsByConnectionIndex = new Map(
              [...completion.viaPaths].map(
                ([connectionIndex, assignment]) =>
                  [connectionIndex, assignment.point] as const,
              ),
            )
          }
        } else {
          matchedRoutingSucceeded = false
        }
      }
      if (matchedRoutingSucceeded) {
        const fixedSourceEscapePathsByConnectionIndex = feasibleViaPaths
          ? new Map(
              [...feasibleViaPaths].map(
                ([connectionIndex, assignment]) =>
                  [connectionIndex, assignment.path] as const,
              ),
            )
          : undefined
        for (const bus of planeBuses) {
          const targetLayer = params.busLayerAssignments[bus.busId]
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
                fixedViaPointsByConnectionIndex,
                fixedSourceEscapePathsByConnectionIndex,
                expandedStateBudget: denseExpandedStateBudget,
              })
            : null
          if (!busPlans) {
            matchedRoutingSucceeded = false
            break
          }
          matchedPlans.push(...busPlans)
        }
      }
      if (
        matchedRoutingSucceeded &&
        fanoutPlansAreClear({
          plans: matchedPlans,
          srj: this.routingSrj,
          sharedBoundary: boundaryBuses[0]!.sharedBoundary,
          clearance: this.config.clearance,
          allowBlindAndBuriedVias: false,
          allowSameNetMerges: this.config.allowSameNetMerges,
        })
      ) {
        return { plans: matchedPlans, failedBusIds: [] }
      }
    }

    const getBudgetExhaustedState = (): MixedTerminationState => {
      const routedBusIds = new Set(
        bestDensePartialPlans.map((plan) => plan.busId),
      )
      return {
        plans: bestDensePartialPlans,
        failedBusIds: [...boundaryBuses, ...planeBuses]
          .filter((bus) => !routedBusIds.has(bus.busId))
          .map((bus) => bus.busId),
      }
    }
    if (denseExpandedStateBudget.exhausted) {
      return getBudgetExhaustedState()
    }

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
              expandedStateBudget: denseExpandedStateBudget,
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
              expandedStateBudget: denseExpandedStateBudget,
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
        expandedStateBudget: denseExpandedStateBudget,
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

    return (
      bestState ??
      (denseExpandedStateBudget.exhausted ? getBudgetExhaustedState() : null)
    )
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

    const mixedTerminationState =
      !useSingleLayerPushAndShove && routingStrategy === "default"
        ? this.routeDenseThroughAllMixedTerminations({
            busLayerAssignments,
            busesInRoutingOrder,
          })
        : null

    if (mixedTerminationState) {
      plans = mixedTerminationState.plans
      failedBusIds = mixedTerminationState.failedBusIds
    }

    let routingPrefixKey = `${routingStrategy}|`
    for (const bus of useSingleLayerPushAndShove || mixedTerminationState
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
        this.inputSrj.connections.length &&
      this.getCoordinatedAdditionalViaCount(bestAttempt.plans) === 0
    ) {
      return bestAttempt
    }

    for (const routingStrategy of ["group-by-layer", "deep-first"] as const) {
      const attempt = this.evaluateAssignmentWithStrategy(
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
        const key = getLayerAssignmentKey(state.assignment)
        const sameAssignmentCount = statesByAssignment.get(key) ?? 0
        if (sameAssignmentCount >= 2) continue
        statesByAssignment.set(key, sameAssignmentCount + 1)
        states.push(state)
        if (states.length >= beamWidth) break
      }
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
      if (state.plans.length !== this.inputSrj.connections.length) continue
      const lengthMatching = this.matchCompletePlanLengths(state.plans)
      if (!lengthMatching.plans) continue
      const lengthMatchedPlans = lengthMatching.plans
      const candidateOutput = buildOutputSimpleRouteJson({
        inputSrj: this.inputSrj,
        plans: lengthMatchedPlans,
        layerNames: this.config.layerNames,
      })
      if (
        !this.validateCompletePlans(lengthMatchedPlans, candidateOutput).valid
      ) {
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

  private prioritizeFailedBusRepairs(
    assignment: Readonly<Record<string, string>>,
    failedBusIds: readonly string[],
    blockingBusIds: readonly string[],
  ): void {
    const assignmentKey = getLayerAssignmentKey(assignment)
    const repairDepth = this.assignmentRepairDepthByKey.get(assignmentKey) ?? 0
    if (repairDepth >= 2) return

    const maximumRepairs = 8
    const repairs: Array<Readonly<Record<string, string>>> = []
    const repairKeys = new Set<string>()
    const addRepair = (repair: Readonly<Record<string, string>>): void => {
      const key = getLayerAssignmentKey(repair)
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

  override _step(): void {
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
      let beamAttempt = this.evaluateGroupedBeam(-1)
      if (!beamAttempt) {
        beamAttempt = this.evaluateGroupedBeam(-1, true)
      }
      if (beamAttempt) {
        this.attempts.push(beamAttempt.summary)
        if (
          !this.bestAttempt ||
          this.isAttemptBetter(beamAttempt, this.bestAttempt)
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
        if (
          this.getCoordinatedAdditionalViaCount(this.bestAttempt.plans) === 0
        ) {
          this.completeBestAttemptEndpoints()
          this.solved = true
          return
        }
      }
      if (
        this.hasCompleteBestAttempt() &&
        this.bestAttempt &&
        this.getCoordinatedAdditionalViaCount(this.bestAttempt.plans) === 0
      ) {
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
      const candidateKey = getLayerAssignmentKey(candidate)
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
        const validationMessage =
          this.lengthMatchingFailure?.message ??
          this.bestAttempt?.summary.validationIssues?.[0]?.message
        this.error = validationMessage
          ? `FanoutSolver: ${validationMessage}`
          : this.bestAttempt
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
    this.evaluatedAssignmentKeys.add(getLayerAssignmentKey(assignment))
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
    const visualizedSrj =
      this.endpointCompletion?.simpleRouteJson ??
      this.bestAttempt?.outputSrj ??
      this.inputSrj
    return visualizeSimpleRouteJson(visualizedSrj)
  }
}
