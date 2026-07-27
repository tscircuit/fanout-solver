import {
  convertSrjToGraphicsObject,
  type SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { BaseSolver } from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "./build-output"
import { distanceSegmentToObstacle } from "./geometry"
import { getCopperLayerColor } from "./layer-colors"
import { generateLayerAssignments, getCopperLayerNames } from "./layer-names"
import { prepareFanoutBuses } from "./prepare-buses"
import { routeBus } from "./route-bus"
import { routeSingleLayerWithPushAndShove } from "./route-single-layer-push-shove"
import type {
  AssignmentAttempt,
  FanoutAttemptSummary,
  FanoutBorderDistribution,
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
  singleLayerPushAndShove: boolean
  borderDistribution: FanoutBorderDistribution
  layerNames: string[]
  escapeLayers: string[]
  maxLayerCombinations: number
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
    singleLayerPushAndShove: options.singleLayerPushAndShove ?? false,
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
  }
}

function assignmentLoadPenalty(
  assignment: Readonly<Record<string, string>>,
): number {
  const loadByLayer = new Map<string, number>()
  for (const layer of Object.values(assignment)) {
    loadByLayer.set(layer, (loadByLayer.get(layer) ?? 0) + 1)
  }
  return [...loadByLayer.values()].reduce(
    (penalty, load) => penalty + load * load,
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

function sourceLayerEscapeIsBlocked(params: {
  bus: PreparedBus
  srj: SimpleRouteJson
  traceWidth: number
  clearance: number
}): boolean {
  const { bus, srj, traceWidth, clearance } = params
  for (const connection of bus.connections) {
    const source = {
      x: connection.sourcePoint.x,
      y: connection.sourcePoint.y,
    }
    const boundaryPoint = (() => {
      switch (bus.direction) {
        case "left":
          return { x: bus.sharedBoundary.minX, y: source.y }
        case "right":
          return { x: bus.sharedBoundary.maxX, y: source.y }
        case "up":
          return { x: source.x, y: bus.sharedBoundary.maxY }
        case "down":
          return { x: source.x, y: bus.sharedBoundary.minY }
      }
    })()
    const directEscapeSegment = {
      start: source,
      end: boundaryPoint,
      width: traceWidth,
      layer: connection.sourceLayer,
    }
    for (const obstacle of srj.obstacles) {
      if (
        obstacle === connection.sourceObstacle ||
        !obstacle.layers.includes(connection.sourceLayer)
      ) {
        continue
      }
      if (
        distanceSegmentToObstacle(directEscapeSegment, obstacle) <
        traceWidth / 2 + clearance - 1e-9
      ) {
        return true
      }
    }
  }
  return false
}

function createPreferredLayerAssignment(params: {
  buses: PreparedBus[]
  escapeLayers: string[]
  srj: SimpleRouteJson
  traceWidth: number
  clearance: number
}): Readonly<Record<string, string>> {
  const { buses, escapeLayers, srj, traceWidth, clearance } = params
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
    const viaLayers = escapeLayers.filter((layer) => layer !== sourceLayer)
    if (
      escapeLayers.includes(sourceLayer) &&
      busIsOnOutwardComponentEdge(bus) &&
      !sourceLayerEscapeIsBlocked({
        bus,
        srj,
        traceWidth,
        clearance,
      })
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
  preferredAssignment: Readonly<Record<string, string>>
  generatedAssignments: Array<Readonly<Record<string, string>>>
  maxAssignments: number
}): Array<Readonly<Record<string, string>>> {
  const { preferredAssignment, generatedAssignments, maxAssignments } = params
  const preferredKey = JSON.stringify(preferredAssignment)
  return [
    preferredAssignment,
    ...generatedAssignments.filter(
      (assignment) => JSON.stringify(assignment) !== preferredKey,
    ),
  ].slice(0, maxAssignments)
}

export class FanoutSolver extends BaseSolver {
  readonly preparedBuses: PreparedBus[]
  readonly attempts: FanoutAttemptSummary[] = []
  readonly layerAssignments: Array<Readonly<Record<string, string>>>
  readonly config: ResolvedFanoutConfig
  private nextAssignmentIndex = 0
  private bestAttempt: AssignmentAttempt | null = null

  constructor(
    public readonly inputSrj: SimpleRouteJson,
    public readonly options: FanoutSolverOptions = {},
  ) {
    super()
    this.config = resolveConfig(inputSrj, options)
    this.preparedBuses = prepareFanoutBuses(inputSrj, options)
    for (const bus of this.preparedBuses) {
      if (bus.termination.type !== "plane") continue
      const planeLayer = bus.termination.layer
      if (!this.config.layerNames.includes(planeLayer)) {
        throw new Error(
          `FanoutSolver: plane-terminated bus "${bus.busId}" targets unavailable layer "${planeLayer}"`,
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
    const generatedAssignments = generateLayerAssignments({
      busIds: boundaryBusIds,
      layers: this.config.escapeLayers,
      maxAssignments: this.config.maxLayerCombinations,
    }).map((assignment) => ({
      ...assignment,
      ...fixedPlaneAssignments,
    }))
    this.layerAssignments = prioritizeLayerAssignment({
      preferredAssignment: createPreferredLayerAssignment({
        buses: this.preparedBuses,
        escapeLayers: this.config.escapeLayers,
        srj: inputSrj,
        traceWidth: this.config.traceWidth,
        clearance: this.config.clearance,
      }),
      generatedAssignments,
      maxAssignments: this.config.maxLayerCombinations,
    })
    this.MAX_ITERATIONS = this.layerAssignments.length + 2
  }

  override getSolverName(): string {
    return "FanoutSolver"
  }

  private evaluateAssignment(
    assignmentIndex: number,
    busLayerAssignments: Readonly<Record<string, string>>,
  ): AssignmentAttempt {
    const plans: AssignmentAttempt["plans"] = []
    const failedBusIds: string[] = []
    const isSingleLayerFanout = this.config.escapeLayers.length === 1
    if (isSingleLayerFanout && this.config.singleLayerPushAndShove) {
      const pushShovePlans = routeSingleLayerWithPushAndShove({
        srj: this.inputSrj,
        buses: this.preparedBuses,
        traceWidth: this.config.traceWidth,
        clearance: this.config.clearance,
        borderDistribution: this.config.borderDistribution,
      })
      if (pushShovePlans) {
        plans.push(...pushShovePlans)
      } else {
        failedBusIds.push(...this.preparedBuses.map((bus) => bus.busId))
      }
    }
    const busesInRoutingOrder = [...this.preparedBuses].sort(
      (a, b) =>
        Number(a.termination.type === "plane") -
          Number(b.termination.type === "plane") ||
        b.componentObstacles.length - a.componentObstacles.length ||
        (isSingleLayerFanout
          ? getBusDistanceToBoundary(b) - getBusDistanceToBoundary(a)
          : b.connections.length - a.connections.length ||
            getBusDistanceToBoundary(a) - getBusDistanceToBoundary(b)),
    )

    for (const bus of isSingleLayerFanout && this.config.singleLayerPushAndShove
      ? []
      : busesInRoutingOrder) {
      const targetLayer = busLayerAssignments[bus.busId]
      if (!targetLayer) {
        throw new Error(
          `FanoutSolver: assignment ${assignmentIndex} has no layer for bus "${bus.busId}"`,
        )
      }
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
      })
      if (!busPlans) {
        failedBusIds.push(bus.busId)
        continue
      }
      plans.push(...busPlans)
    }

    const routedBusCount = this.preparedBuses.length - failedBusIds.length
    const routeLength = plans.reduce((total, plan) => total + plan.length, 0)
    const unroutedConnectionCount =
      this.inputSrj.connections.length - plans.length
    const score =
      unroutedConnectionCount * 1_000_000 +
      failedBusIds.length * 100_000 +
      routeLength +
      plans.filter((plan) => plan.via).length * 0.1 +
      assignmentLoadPenalty(busLayerAssignments) * 0.01
    const summary: FanoutAttemptSummary = {
      assignmentIndex,
      busLayerAssignments,
      routedBusCount,
      routedConnectionCount: plans.length,
      failedBusIds,
      score,
    }

    return {
      summary,
      plans,
      outputSrj: buildOutputSimpleRouteJson({
        inputSrj: this.inputSrj,
        plans,
        layerNames: this.config.layerNames,
      }),
    }
  }

  override _step(): void {
    const assignment = this.layerAssignments[this.nextAssignmentIndex]
    if (!assignment) {
      if (
        this.bestAttempt &&
        this.bestAttempt.summary.routedConnectionCount ===
          this.inputSrj.connections.length
      ) {
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
    this.attempts.push(attempt.summary)
    if (
      !this.bestAttempt ||
      attempt.summary.score < this.bestAttempt.summary.score
    ) {
      this.bestAttempt = attempt
    }
    this.stats = {
      assignment: attempt.summary.assignmentIndex + 1,
      assignmentCount: this.layerAssignments.length,
      routedBuses: `${attempt.summary.routedBusCount}/${this.preparedBuses.length}`,
      routedConnections: `${attempt.summary.routedConnectionCount}/${this.inputSrj.connections.length}`,
      failedBuses: attempt.summary.failedBusIds.join(", ") || "none",
      bestScore: this.bestAttempt.summary.score,
    }
    if (
      attempt.summary.routedConnectionCount === this.inputSrj.connections.length
    ) {
      this.solved = true
    }
  }

  computeProgress(): number {
    if (this.solved || this.failed) return 1
    return this.nextAssignmentIndex / this.layerAssignments.length
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
    return {
      simpleRouteJson: this.bestAttempt.outputSrj,
      fanoutTraces: this.bestAttempt.plans.map((plan) => plan.trace),
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
    }
  }

  getOutputSimpleRouteJson(): SimpleRouteJson {
    return this.getOutput().simpleRouteJson
  }

  override visualize(): GraphicsObject {
    const visualizedSrj = this.bestAttempt?.outputSrj ?? this.inputSrj
    const graphics = convertSrjToGraphicsObject(visualizedSrj)
    const circularPadKeys = new Set(
      visualizedSrj.obstacles
        .filter(
          (obstacle) =>
            (obstacle as typeof obstacle & { shape?: string }).shape ===
            "circle",
        )
        .map(
          (obstacle) =>
            `${obstacle.center.x}:${obstacle.center.y}:${obstacle.width}:${obstacle.height}`,
        ),
    )
    const circularPadGraphics: NonNullable<GraphicsObject["circles"]> = []
    const rects = graphics.rects?.filter((rect) => {
      const key = `${rect.center.x}:${rect.center.y}:${rect.width}:${rect.height}`
      if (!circularPadKeys.has(key)) return true
      circularPadGraphics.push({
        center: rect.center,
        radius: Math.min(rect.width, rect.height) / 2,
        fill: rect.fill,
        stroke: rect.stroke,
        layer: rect.layer,
        label: rect.label,
      })
      return false
    })
    return {
      ...graphics,
      rects,
      circles: [...(graphics.circles ?? []), ...circularPadGraphics],
      lines: graphics.lines?.map((line) => {
        const layerMatch = /^z(\d+)$/.exec(line.layer ?? "")
        if (!layerMatch) return line
        const { strokeDash: _strokeDash, ...solidLine } = line
        return {
          ...solidLine,
          strokeColor: getCopperLayerColor(Number(layerMatch[1])),
        }
      }),
    }
  }
}
