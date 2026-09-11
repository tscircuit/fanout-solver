import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { matchComponentDogboneViaSites } from "./match-component-dogbone-via-sites"
import { fanoutPlansAreClear } from "./route-bus"
import { routeSingleLayerWithAdaptiveExitsSteps } from "./route-single-layer-adaptive-exits"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type {
  Bounds,
  FanoutDirection,
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
} from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"
import { getViaHoleToHoleClearance } from "./via-clearance"

export interface LayerReservedSourceEscapeParams {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  maximumSearchStates?: number
  /** An existing complete local matching whose sites must start unchanged. */
  initialViaPointsByConnectionIndex?: ReadonlyMap<number, Point2D>
}

export interface LayerReservedSourceEscapes {
  sourceBoundary: Bounds
  /** Complete reservations, including every local and remote through via. */
  fixedViaPointsByConnectionIndex: Map<number, Point2D>
  sourceEscapePaths: Map<number, readonly Point2D[]>
  /** Every connection's source copper; these are not completed boundary buses. */
  sourcePlans: FanoutRoutePlan[]
  /** The preserved source-layer prefixes before their outward via stubs. */
  prefixPlans: FanoutRoutePlan[]
  remotePlans: FanoutRoutePlan[]
  layerGroups: Array<{
    layer: string
    connectionCount: number
    escapedCount: number
  }>
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
    const halfWidth = obstacle.width / 2,
      halfHeight = obstacle.height / 2
    const x =
      shaped.shape === "circle"
        ? halfWidth
        : Math.abs(Math.cos(radians)) * halfWidth +
          Math.abs(Math.sin(radians)) * halfHeight
    const y =
      shaped.shape === "circle"
        ? halfHeight
        : Math.abs(Math.sin(radians)) * halfWidth +
          Math.abs(Math.cos(radians)) * halfHeight
    bounds.minX = Math.min(bounds.minX, obstacle.center.x - x)
    bounds.maxX = Math.max(bounds.maxX, obstacle.center.x + x)
    bounds.minY = Math.min(bounds.minY, obstacle.center.y - y)
    bounds.maxY = Math.max(bounds.maxY, obstacle.center.y + y)
  }
  return bounds
}

/** Match the occupied source field independently of the remote destination. */
function getMatchingBuses(
  buses: readonly PreparedBus[],
  padBounds: Bounds,
): PreparedBus[] {
  const boundary = buses.filter((bus) => bus.termination.type === "boundary")
  const edge = boundary[0]?.exitEdge
  if (!edge || boundary.some((bus) => bus.exitEdge !== edge)) return [...buses]
  const connections = boundary.flatMap((bus) => bus.connections)
  const center = {
    x: (padBounds.minX + padBounds.maxX) / 2,
    y: (padBounds.minY + padBounds.maxY) / 2,
  }
  const dx = connections.reduce((sum, c) => sum + c.sourcePoint.x - center.x, 0)
  const dy = connections.reduce((sum, c) => sum + c.sourcePoint.y - center.y, 0)
  if (Math.hypot(dx, dy) < 1e-9) return [...buses]
  const directions: FanoutDirection[] = ["right", "up", "left", "down"]
  const fieldDirection =
    Math.abs(dx) >= Math.abs(dy)
      ? dx >= 0
        ? "right"
        : "left"
      : dy >= 0
        ? "up"
        : "down"
  const edgeDirection =
    edge === "top" ? "up" : edge === "bottom" ? "down" : edge
  const rotation =
    directions.indexOf(fieldDirection) - directions.indexOf(edgeDirection)
  return buses.map((bus) =>
    bus.termination.type === "plane"
      ? bus
      : {
          ...bus,
          direction:
            directions[(directions.indexOf(bus.direction) + rotation + 4) % 4]!,
        },
  )
}

function reserveSourceCopper(plans: readonly FanoutRoutePlan[]): Obstacle[] {
  return plans.flatMap((plan) => {
    const connectedTo = [plan.connectionName],
      layers = [plan.sourceLayer]
    const obstacles: Obstacle[] = []
    if (plan.via)
      obstacles.push({
        type: "rect",
        shape: "circle",
        center: plan.via.center,
        width: plan.via.diameter,
        height: plan.via.diameter,
        connectedTo,
        layers,
      } as Obstacle)
    for (const segment of plan.segments) {
      const { start, end, width } = segment,
        dx = end.x - start.x,
        dy = end.y - start.y
      obstacles.push({
        type: "rect",
        center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
        width: Math.hypot(dx, dy),
        height: width,
        ccwRotationDegrees: (Math.atan2(dy, dx) * 180) / Math.PI,
        connectedTo,
        layers,
      } as Obstacle)
    }
    // Rounded segment ends matter once a previous group has bent prefixes.
    for (const point of [
      plan.sourcePoint,
      ...plan.segments.map((segment) => segment.end),
    ]) {
      obstacles.push({
        type: "rect",
        shape: "circle",
        center: point,
        width: plan.segments[0]?.width ?? 0,
        height: plan.segments[0]?.width ?? 0,
        connectedTo,
        layers,
      } as Obstacle)
    }
    return obstacles
  })
}

/**
 * Prepare source escapes one constrained target layer at a time. Wider buses
 * go first, with every other source's real copper and through via reserved.
 * This returns complete source reservations only; callers must still route
 * and validate every original atomic bus before committing a solution.
 */
export function* routeLayerReservedSourceEscapesSteps(
  params: LayerReservedSourceEscapeParams,
): Generator<void, LayerReservedSourceEscapes | null, unknown> {
  const {
    srj,
    buses,
    layerNames,
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
  } = params
  const first = buses[0]
  if (
    !first ||
    buses.some(
      (bus) =>
        bus.componentId !== first.componentId ||
        bus.connections.some((c) => c.sourceLayer !== "top"),
    )
  )
    return null
  const pads = first.componentObstacles.filter((obstacle) =>
    obstacle.layers.includes("top"),
  )
  if (!pads.length) return null
  const padBounds = getPadBounds(pads),
    padPitch = Math.max(first.pitchX, first.pitchY),
    pitch = traceWidth + clearance
  if (!Number.isFinite(padPitch) || padPitch <= 0) return null
  // Same pad-bound and trace-pitch construction as plane-reserved escapes.
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
  const byLayer = new Map<string, PreparedBus[]>()
  for (const bus of buses) {
    if (
      bus.termination.type !== "boundary" ||
      bus.allowedLayers?.length !== 1 ||
      bus.allowedLayers[0] === "top"
    )
      continue
    const layer = bus.allowedLayers[0]!
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), bus])
  }
  const groups = [...byLayer].sort(
    ([layerA, a], [layerB, b]) =>
      Math.max(...b.map((bus) => bus.connections.length)) -
        Math.max(...a.map((bus) => bus.connections.length)) ||
      layerA.localeCompare(layerB),
  )
  if (!groups.length) return null
  const owners = new Map(
    buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  if (
    owners.size !==
    buses.reduce((count, bus) => count + bus.connections.length, 0)
  )
    throw new Error(
      "FanoutSolver: source preparation requires unique connection indices",
    )
  const matchingBuses = getMatchingBuses(buses, padBounds)
  const rules = {
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
    holeToHoleClearance: getViaHoleToHoleClearance(srj),
    maximumSearchStates: params.maximumSearchStates ?? 10_000,
    additionalObstacles: srj.obstacles,
  }
  const supplied = params.initialViaPointsByConnectionIndex
  if (
    supplied &&
    (supplied.size !== owners.size ||
      [...supplied].some(
        ([index, point]) =>
          !owners.has(index) ||
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y),
      ))
  )
    throw new Error(
      "FanoutSolver: initial source sites must contain every connection exactly once",
    )
  const initial = matchComponentDogboneViaSites(matchingBuses, {
    ...rules,
    fixedViaPointsByConnectionIndex: supplied,
  })
  if (!initial) return null
  const makePlan = (
    index: number,
    viaPoint: Point2D,
    path: readonly Point2D[],
  ): FanoutRoutePlan => {
    const { bus, connection } = owners.get(index)!
    const targetLayer =
      bus.termination.type === "plane"
        ? bus.termination.layer
        : (bus.allowedLayers ?? layerNames)
            .filter((layer) => layer !== connection.sourceLayer)
            .at(-1)
    if (!targetLayer)
      throw new Error(
        "FanoutSolver: source through-via preparation requires a non-source target layer",
      )
    return buildViaMinimalWindingPlan({
      ...params,
      allowBlindAndBuriedVias: false,
      bus,
      terminal: { connection, viaPoint, exitPoint: viaPoint },
      targetLayer,
      targetLayerPoints: [viaPoint],
      sourceEscapePoints: path,
    })
  }
  const makePlans = (
    sites: ReadonlyMap<number, Point2D>,
    paths: ReadonlyMap<number, readonly Point2D[]>,
  ) =>
    [...owners.keys()].map((index) =>
      makePlan(index, sites.get(index)!, paths.get(index)!),
    )
  const isClear = (plans: FanoutRoutePlan[]) =>
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: {
        ...srj,
        traces: [...(srj.traces ?? []), ...plans.map((plan) => plan.trace)],
      },
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid
  let current: LayerReservedSourceEscapes = {
    sourceBoundary,
    fixedViaPointsByConnectionIndex: initial,
    sourceEscapePaths: new Map(
      [...initial].map(([index, point]) => [
        index,
        [owners.get(index)!.connection.sourcePoint, point],
      ]),
    ),
    sourcePlans: [],
    prefixPlans: [],
    remotePlans: [],
    layerGroups: [],
  }
  current.sourcePlans = makePlans(initial, current.sourceEscapePaths)
  if (!isClear(current.sourcePlans)) return null
  const stubLength = Math.max(
    padPitch,
    viaDiameter / 2 + traceWidth / 2 + clearance,
  )
  for (const [layer, groupBuses] of groups) {
    const own = new Set(
      groupBuses.flatMap((bus) =>
        bus.connections.map((c) => c.connectionIndex),
      ),
    )
    const priorRemote = new Set(
      current.remotePlans.map((plan) => plan.connectionIndex),
    )
    const fixedOthers = new Map(
      [...current.fixedViaPointsByConnectionIndex].filter(
        ([index]) => !own.has(index) && !priorRemote.has(index),
      ),
    )
    const reservedSrj = {
      ...srj,
      obstacles: [
        ...srj.obstacles,
        ...reserveSourceCopper(
          current.sourcePlans.filter((plan) => !own.has(plan.connectionIndex)),
        ),
      ],
    }
    const singletonBuses = groupBuses.flatMap((bus) =>
      bus.connections.map((connection) => ({
        ...bus,
        busId: `${bus.busId}:source-${connection.connectionIndex}`,
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
    let best: LayerReservedSourceEscapes | null = null
    let bestCount = 0
    const consider = (candidate: FanoutRoutePlan[]) => {
      if (candidate.length <= bestCount) return
      const prefixes = candidate.map((plan) => ({
        ...plan,
        busId: owners.get(plan.connectionIndex)!.bus.busId,
        sourceObstacle: owners.get(plan.connectionIndex)!.connection
          .sourceObstacle,
        sourceEscapeSegmentCount: plan.segments.length,
      }))
      if (
        !fanoutPlansAreClear({
          plans: prefixes,
          srj: reservedSrj,
          sharedBoundary: sourceBoundary,
          clearance,
          allowBlindAndBuriedVias: false,
          allowSameNetMerges: false,
        })
      )
        return
      const remote: FanoutRoutePlan[] = []
      const paths = new Map<number, readonly Point2D[]>()
      for (const prefix of prefixes) {
        const p = prefix.exitPoint
        const delta =
          Math.abs(p.x - sourceBoundary.maxX) < 1e-7
            ? { x: stubLength, y: 0 }
            : Math.abs(p.x - sourceBoundary.minX) < 1e-7
              ? { x: -stubLength, y: 0 }
              : Math.abs(p.y - sourceBoundary.maxY) < 1e-7
                ? { x: 0, y: stubLength }
                : Math.abs(p.y - sourceBoundary.minY) < 1e-7
                  ? { x: 0, y: -stubLength }
                  : null
        if (!delta)
          throw new Error(
            "FanoutSolver: source prefix does not end on its source boundary",
          )
        const viaPoint = { x: p.x + delta.x, y: p.y + delta.y }
        const bounds = owners.get(prefix.connectionIndex)!.bus.sharedBoundary
        if (
          viaPoint.x < bounds.minX ||
          viaPoint.x > bounds.maxX ||
          viaPoint.y < bounds.minY ||
          viaPoint.y > bounds.maxY
        )
          return
        const path = [
          prefix.sourcePoint,
          ...prefix.segments.map((segment) => segment.end),
          viaPoint,
        ]
        paths.set(prefix.connectionIndex, path)
        remote.push(makePlan(prefix.connectionIndex, viaPoint, path))
      }
      const allRemote = [...current.remotePlans, ...remote]
      if (!isClear(allRemote)) return
      const escaped = new Set(allRemote.map((plan) => plan.connectionIndex))
      const remaining = matchingBuses
        .map((bus) => ({
          ...bus,
          connections: bus.connections.filter(
            (c) => !escaped.has(c.connectionIndex),
          ),
        }))
        .filter((bus) => bus.connections.length)
      const local = matchComponentDogboneViaSites(remaining, {
        ...rules,
        fixedViaPointsByConnectionIndex: fixedOthers,
        preferredViaPointsByConnectionIndex:
          current.fixedViaPointsByConnectionIndex,
        blockingSegments: allRemote.flatMap((plan) =>
          plan.segments.map((segment) => ({
            connectionIndex: plan.connectionIndex,
            segment,
          })),
        ),
        blockingVias: allRemote.map((plan) => ({
          connectionIndex: plan.connectionIndex,
          center: plan.via!.center,
          diameter: plan.via!.diameter,
          holeDiameter: plan.via!.holeDiameter,
          spanLayers: plan.via!.spanLayers,
        })),
      })
      if (!local) return
      const sites = new Map([
        ...local,
        ...allRemote.map(
          (plan) => [plan.connectionIndex, plan.via!.center] as const,
        ),
      ])
      if (sites.size !== owners.size)
        throw new Error("FanoutSolver: source preparation lost a connection")
      for (const index of priorRemote)
        paths.set(index, current.sourceEscapePaths.get(index)!)
      for (const [index, point] of local)
        paths.set(index, [owners.get(index)!.connection.sourcePoint, point])
      const sourcePlans = makePlans(sites, paths)
      if (!isClear(sourcePlans)) return
      bestCount = candidate.length
      best = {
        sourceBoundary,
        fixedViaPointsByConnectionIndex: sites,
        sourceEscapePaths: paths,
        sourcePlans,
        prefixPlans: [...current.prefixPlans, ...prefixes],
        remotePlans: allRemote,
        layerGroups: [
          ...current.layerGroups,
          { layer, connectionCount: own.size, escapedCount: candidate.length },
        ],
      }
    }
    const complete = yield* routeSingleLayerWithAdaptiveExitsSteps({
      srj: reservedSrj,
      buses: singletonBuses,
      traceWidth,
      clearance,
      onPartialRoutes: consider,
    })
    if (complete) consider(complete)
    if (best) current = best
    else
      current.layerGroups.push({
        layer,
        connectionCount: own.size,
        escapedCount: 0,
      })
  }
  return current.remotePlans.length ? current : null
}
