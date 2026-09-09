import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { fanoutPlansAreClear } from "./route-bus"
import type { SourceOriginReservations } from "./route-source-origin-buses"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type { Bounds, FanoutDirection, Point2D, PreparedBus } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

export interface PeripheralSourceReservationParams {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  allowBlindAndBuriedVias?: boolean
  /** Inward sites leave the space between the leads and boundary available. */
  side?: "inward" | "outward"
}

const EPSILON = 1e-7
const opposite: Record<FanoutDirection, FanoutDirection> = {
  left: "right",
  right: "left",
  up: "down",
  down: "up",
}

function padSize(obstacle: Obstacle): Point2D | null {
  const shaped = obstacle as Obstacle & {
    shape?: string
    ccwRotationDegrees?: number
  }
  if (shaped.shape === "circle" || obstacle.type !== "rect") return null
  const quarterTurns = (shaped.ccwRotationDegrees ?? 0) / 90
  if (Math.abs(quarterTurns - Math.round(quarterTurns)) > EPSILON) return null
  return Math.abs(Math.round(quarterTurns)) % 2 === 0
    ? { x: obstacle.width, y: obstacle.height }
    : { x: obstacle.height, y: obstacle.width }
}

function outwardDirection(
  bounds: Bounds,
  obstacle: Obstacle,
): FanoutDirection | null {
  const size = padSize(obstacle)
  if (!size || Math.abs(size.x - size.y) < EPSILON) return null
  const { center } = obstacle
  if (size.x > size.y) {
    if (Math.abs(center.x - size.x / 2 - bounds.minX) < EPSILON) return "left"
    if (Math.abs(center.x + size.x / 2 - bounds.maxX) < EPSILON) return "right"
  } else {
    if (Math.abs(center.y - size.y / 2 - bounds.minY) < EPSILON) return "down"
    if (Math.abs(center.y + size.y / 2 - bounds.maxY) < EPSILON) return "up"
  }
  return null
}

/** Lead bodies need an axial escape beyond their ends, not a half-pad-pitch via. */
export function preparePeripheralSourceReservations(
  params: PeripheralSourceReservationParams,
): SourceOriginReservations | null {
  const first = params.buses[0]
  if (
    !first ||
    params.allowBlindAndBuriedVias ||
    params.buses.some(
      (bus) =>
        bus.componentId !== first.componentId ||
        bus.connections.some((connection) => connection.sourceLayer !== "top"),
    )
  )
    return null
  const bounds: Bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  }
  for (const obstacle of first.componentObstacles) {
    const size = padSize(obstacle)
    if (!size) return null
    bounds.minX = Math.min(bounds.minX, obstacle.center.x - size.x / 2)
    bounds.maxX = Math.max(bounds.maxX, obstacle.center.x + size.x / 2)
    bounds.minY = Math.min(bounds.minY, obstacle.center.y - size.y / 2)
    bounds.maxY = Math.max(bounds.maxY, obstacle.center.y + size.y / 2)
  }
  const directions = new Set<FanoutDirection>()
  for (const bus of params.buses) {
    if (bus.termination.type !== "boundary") continue
    for (const connection of bus.connections) {
      const direction = outwardDirection(bounds, connection.sourceObstacle)
      if (!direction) return null
      directions.add(direction)
    }
  }
  // Restrict this source alternative to packages with peripheral leads on all
  // four sides. Dense arrays retain their interstitial source matching.
  if (directions.size !== 4) return null
  const fixedViaPointsByConnectionIndex = new Map<number, Point2D>(),
    sourceEscapePaths = new Map<number, readonly Point2D[]>()
  const sourcePlans = []
  for (const bus of params.buses) {
    const targetLayer =
      bus.termination.type === "plane"
        ? bus.termination.layer
        : (bus.routableEscapeLayers ?? bus.allowedLayers ?? params.layerNames)
            .filter((layer) => layer !== "top")
            .at(-1)
    if (!targetLayer || !params.layerNames.includes(targetLayer)) return null
    for (const connection of bus.connections) {
      const obstacle = connection.sourceObstacle,
        size = padSize(obstacle)
      if (!size) return null
      let direction = outwardDirection(bounds, obstacle)
      if (!direction) {
        if (bus.termination.type !== "plane") return null
        direction = bus.direction
      } else if ((params.side ?? "inward") === "inward") {
        direction = opposite[direction]
      }
      const source = connection.sourcePoint,
        margin = params.viaDiameter / 2 + params.clearance + 0.001
      const viaPoint =
        direction === "left"
          ? { x: obstacle.center.x - size.x / 2 - margin, y: source.y }
          : direction === "right"
            ? { x: obstacle.center.x + size.x / 2 + margin, y: source.y }
            : direction === "up"
              ? { x: source.x, y: obstacle.center.y + size.y / 2 + margin }
              : { x: source.x, y: obstacle.center.y - size.y / 2 - margin }
      const boundary = bus.sharedBoundary,
        radius = params.viaDiameter / 2
      if (
        viaPoint.x - radius < boundary.minX ||
        viaPoint.x + radius > boundary.maxX ||
        viaPoint.y - radius < boundary.minY ||
        viaPoint.y + radius > boundary.maxY
      )
        return null
      if (fixedViaPointsByConnectionIndex.has(connection.connectionIndex))
        throw new Error("FanoutSolver: duplicate peripheral source connection")
      fixedViaPointsByConnectionIndex.set(connection.connectionIndex, viaPoint)
      sourceEscapePaths.set(connection.connectionIndex, [source, viaPoint])
      sourcePlans.push(
        buildViaMinimalWindingPlan({
          ...params,
          bus,
          terminal: { connection, viaPoint, exitPoint: viaPoint },
          targetLayer,
          targetLayerPoints: [viaPoint],
          sourceEscapePoints: [source, viaPoint],
          allowBlindAndBuriedVias: false,
        }),
      )
    }
  }
  if (
    !fanoutPlansAreClear({
      ...params,
      plans: sourcePlans,
      sharedBoundary: first.sharedBoundary,
      allowBlindAndBuriedVias: false,
    }) ||
    !validateRoutedCopperDrc({
      inputSrj: params.srj,
      routedSrj: {
        ...params.srj,
        traces: [
          ...(params.srj.traces ?? []),
          ...sourcePlans.map((p) => p.trace),
        ],
      },
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }).valid
  )
    return null
  return { fixedViaPointsByConnectionIndex, sourceEscapePaths, sourcePlans }
}
