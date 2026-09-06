import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { matchComponentDogboneViaSites } from "./match-component-dogbone-via-sites"
import { fanoutPlansAreClear } from "./route-bus"
import { routeSingleLayerWithAdaptiveExitsSteps } from "./route-single-layer-adaptive-exits"
import type {
  Bounds,
  FanoutDirection,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
} from "./types"

export interface PlaneReservedSourceEscapeParams {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  maximumSearchStates?: number
}

export interface PlaneReservedSourceEscapes {
  /** Before-via prefixes only; original buses still require complete routes. */
  prefixPlans: FanoutRoutePlan[]
  sourceBoundary: Bounds
  fixedPlaneSites: Map<number, Point2D>
  remainingViaPointsByConnectionIndex: Map<number, Point2D>
}

function getPadBounds(obstacles: readonly Obstacle[]): Bounds {
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  }
  for (const obstacle of obstacles) {
    const shaped = obstacle as Obstacle & {
      shape?: "circle"
      ccwRotationDegrees?: number
    }
    const radians = ((shaped.ccwRotationDegrees ?? 0) * Math.PI) / 180
    const halfWidth = obstacle.width / 2
    const halfHeight = obstacle.height / 2
    const radiusX =
      shaped.shape === "circle"
        ? halfWidth
        : Math.abs(Math.cos(radians)) * halfWidth +
          Math.abs(Math.sin(radians)) * halfHeight
    const radiusY =
      shaped.shape === "circle"
        ? halfWidth
        : Math.abs(Math.sin(radians)) * halfWidth +
          Math.abs(Math.cos(radians)) * halfHeight
    bounds.minX = Math.min(bounds.minX, obstacle.center.x - radiusX)
    bounds.maxX = Math.max(bounds.maxX, obstacle.center.x + radiusX)
    bounds.minY = Math.min(bounds.minY, obstacle.center.y - radiusY)
    bounds.maxY = Math.max(bounds.maxY, obstacle.center.y + radiusY)
  }
  return bounds
}

/**
 * Reserve every local plane escape, then find source-layer signal prefixes
 * without consuming the via capacity needed by any unmatched connection.
 * Nothing is committed: the caller must extend these prefixes through legal
 * vias and finish each original atomic bus before accepting a solution.
 */
export function* routePlaneReservedSourceEscapesSteps(
  params: PlaneReservedSourceEscapeParams,
): Generator<void, PlaneReservedSourceEscapes | null, unknown> {
  const { srj, buses, traceWidth, clearance, viaDiameter, viaHoleDiameter } =
    params
  const firstBus = buses[0]
  if (
    !firstBus ||
    buses.some(
      (bus) =>
        bus.componentId !== firstBus.componentId ||
        bus.connections.some((connection) => connection.sourceLayer !== "top"),
    )
  )
    return null
  const planeBuses = buses.filter((bus) => bus.termination.type === "plane")
  const boundaryBuses = buses.filter(
    (bus) => bus.termination.type === "boundary",
  )
  if (!planeBuses.length || !boundaryBuses.length) return null
  const pads = firstBus.componentObstacles.filter((obstacle) =>
    obstacle.layers.includes("top"),
  )
  if (!pads.length) return null
  const padBounds = getPadBounds(pads)
  const pitch = traceWidth + clearance
  const padPitch = Math.max(firstBus.pitchX, firstBus.pitchY)
  if (!Number.isFinite(padPitch) || padPitch <= 0) return null
  const center = {
    x: (padBounds.minX + padBounds.maxX) / 2,
    y: (padBounds.minY + padBounds.maxY) / 2,
  }
  const halfWidth =
    Math.ceil(
      ((padBounds.maxX - padBounds.minX) / 2 + padPitch + pitch) / pitch,
    ) * pitch
  const halfHeight =
    Math.ceil(
      ((padBounds.maxY - padBounds.minY) / 2 + padPitch + pitch) / pitch,
    ) * pitch
  const sourceBoundary = {
    minX: center.x - halfWidth,
    maxX: center.x + halfWidth,
    minY: center.y - halfHeight,
    maxY: center.y + halfHeight,
  }
  if (
    buses.some(
      (bus) =>
        sourceBoundary.minX <= bus.sharedBoundary.minX ||
        sourceBoundary.maxX >= bus.sharedBoundary.maxX ||
        sourceBoundary.minY <= bus.sharedBoundary.minY ||
        sourceBoundary.maxY >= bus.sharedBoundary.maxY,
    )
  )
    return null
  const rules = {
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
    maximumSearchStates: params.maximumSearchStates ?? 10_000,
    additionalObstacles: srj.obstacles,
  }
  const initialSites = matchComponentDogboneViaSites(buses, rules)
  if (!initialSites) return null
  const fixedPlaneSites = new Map<number, Point2D>()
  const reservations: Obstacle[] = []
  for (const bus of planeBuses) {
    for (const connection of bus.connections) {
      const viaPoint = initialSites.get(connection.connectionIndex)!
      fixedPlaneSites.set(connection.connectionIndex, viaPoint)
      const source = connection.sourcePoint
      const dx = viaPoint.x - source.x
      const dy = viaPoint.y - source.y
      reservations.push({
        type: "rect",
        shape: "circle",
        center: viaPoint,
        width: viaDiameter,
        height: viaDiameter,
        layers: ["top"],
        connectedTo: [connection.connection.name],
      } as Obstacle)
      reservations.push({
        type: "rect",
        center: {
          x: (source.x + viaPoint.x) / 2,
          y: (source.y + viaPoint.y) / 2,
        },
        width: Math.hypot(dx, dy),
        height: traceWidth,
        ccwRotationDegrees: (Math.atan2(dy, dx) * 180) / Math.PI,
        layers: ["top"],
        connectedTo: [connection.connection.name],
      } as Obstacle)
    }
  }
  const reservedSrj = { ...srj, obstacles: [...srj.obstacles, ...reservations] }
  const ownerByIndex = new Map(
    buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const singletonBuses = boundaryBuses.flatMap((bus) =>
    bus.connections.map((connection) => ({
      ...bus,
      busId: `${bus.busId}:source-perimeter:${connection.connectionIndex}`,
      sharedBoundary: sourceBoundary,
      preferredExit: undefined,
      exitEdge: undefined,
      connections: [
        {
          ...connection,
          exitTargetPoint: undefined,
          hasExplicitLayeredExitTarget: false,
        },
      ],
    })),
  )
  let best: PlaneReservedSourceEscapes | null = null
  const consider = (candidatePlans: FanoutRoutePlan[]) => {
    if (candidatePlans.length <= (best?.prefixPlans.length ?? 0)) return
    const prefixPlans = candidatePlans.map((plan) => {
      const owner = ownerByIndex.get(plan.connectionIndex)!
      const direction: FanoutDirection =
        Math.abs(plan.exitPoint.x - sourceBoundary.minX) < 1e-9
          ? "left"
          : Math.abs(plan.exitPoint.x - sourceBoundary.maxX) < 1e-9
            ? "right"
            : Math.abs(plan.exitPoint.y - sourceBoundary.minY) < 1e-9
              ? "down"
              : "up"
      return {
        ...plan,
        busId: owner.bus.busId,
        direction,
        exitEdge:
          direction === "up"
            ? ("top" as const)
            : direction === "down"
              ? ("bottom" as const)
              : direction,
        sourceObstacle: owner.connection.sourceObstacle,
        sourceEscapeSegmentCount: plan.segments.length,
      }
    })
    if (
      !fanoutPlansAreClear({
        plans: prefixPlans,
        srj: reservedSrj,
        sharedBoundary: sourceBoundary,
        clearance,
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: false,
      })
    )
      return
    const escapedIndices = new Set(
      prefixPlans.map((plan) => plan.connectionIndex),
    )
    const remainingBuses = buses
      .map((bus) => ({
        ...bus,
        connections: bus.connections.filter(
          (connection) => !escapedIndices.has(connection.connectionIndex),
        ),
      }))
      .filter((bus) => bus.connections.length > 0)
    const remainingViaPointsByConnectionIndex = matchComponentDogboneViaSites(
      remainingBuses,
      {
        ...rules,
        fixedViaPointsByConnectionIndex: fixedPlaneSites,
        blockingSegments: prefixPlans.flatMap((plan) =>
          plan.segments.map((segment) => ({
            connectionIndex: plan.connectionIndex,
            segment,
          })),
        ),
      },
    )
    if (!remainingViaPointsByConnectionIndex) return
    best = {
      prefixPlans,
      sourceBoundary,
      fixedPlaneSites,
      remainingViaPointsByConnectionIndex,
    }
  }
  const completePrefixes = yield* routeSingleLayerWithAdaptiveExitsSteps({
    srj: reservedSrj,
    buses: singletonBuses,
    traceWidth,
    clearance,
    onPartialRoutes: consider,
  })
  if (completePrefixes) consider(completePrefixes)
  return best
}
