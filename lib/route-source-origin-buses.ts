import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { matchComponentDogboneViaSites } from "./match-component-dogbone-via-sites"
import {
  routeReservedViaBusesSteps,
  type RouteReservedViaBusesParams,
  type ReservedViaBusesProgress,
} from "./route-reserved-via-buses"
import { buildViaMinimalWindingPlan } from "./route-via-minimal-winding"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

interface SourceRules {
  srj: SimpleRouteJson
  buses: readonly PreparedBus[]
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
}

export interface SourceOriginReservations {
  fixedViaPointsByConnectionIndex: Map<number, Point2D>
  sourceEscapePaths: Map<number, readonly Point2D[]>
  sourcePlans: FanoutRoutePlan[]
}

function makeSourcePlans(
  params: SourceRules,
  sites: ReadonlyMap<number, Point2D>,
  paths: ReadonlyMap<number, readonly Point2D[]>,
): FanoutRoutePlan[] {
  return params.buses.flatMap((bus) =>
    bus.connections.map((connection) => {
      const viaPoint = sites.get(connection.connectionIndex)!
      const targetLayer =
        bus.termination.type === "plane"
          ? bus.termination.layer
          : (bus.allowedLayers ?? params.layerNames)
              .filter((layer) => layer !== connection.sourceLayer)
              .at(-1)!
      return buildViaMinimalWindingPlan({
        ...params,
        bus,
        terminal: { connection, viaPoint, exitPoint: viaPoint },
        targetLayer,
        targetLayerPoints: [viaPoint],
        sourceEscapePoints: paths.get(connection.connectionIndex),
        allowBlindAndBuriedVias: false,
      })
    }),
  )
}

/** Reserve every source before freeing a selected boundary group jointly. */
export function prepareSourceOriginReservations(
  params: SourceRules,
): SourceOriginReservations | null {
  if (
    !params.buses.length ||
    params.buses.some((bus) =>
      bus.connections.some((c) => c.sourceLayer !== "top"),
    )
  )
    return null
  const sites = matchComponentDogboneViaSites(params.buses, {
    ...params,
    maximumSearchStates: 10_000,
    additionalObstacles: params.srj.obstacles,
  })
  if (!sites) return null
  const paths = new Map(
    params.buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [
            connection.connectionIndex,
            [connection.sourcePoint, sites.get(connection.connectionIndex)!],
          ] as const,
      ),
    ),
  )
  const sourcePlans = makeSourcePlans(params, sites, paths)
  if (
    !validateRoutedCopperDrc({
      inputSrj: params.srj,
      routedSrj: {
        ...params.srj,
        traces: [
          ...(params.srj.traces ?? []),
          ...sourcePlans.map((plan) => plan.trace),
        ],
      },
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }).valid
  )
    return null
  return {
    fixedViaPointsByConnectionIndex: sites,
    sourceEscapePaths: paths,
    sourcePlans,
  }
}

interface SourceOriginResult extends SourceOriginReservations {
  /** Every connection of the selected original buses, still awaiting length matching. */
  plans: FanoutRoutePlan[]
}

/**
 * Choose first vias collectively, then shorten a bounded set of complete lanes.
 * Other sources and already routed copper remain immutable. Each replacement
 * preserves the original endpoint and cannot increase its complete bus's skew.
 */
export function* routeSourceOriginBusesSteps(
  params: RouteReservedViaBusesParams,
): Generator<ReservedViaBusesProgress, SourceOriginResult | null, unknown> {
  const initialSteps = routeReservedViaBusesSteps({
    ...params,
    transitLayers: [],
    routeFromSourcePads: true,
    sourceLayerTravelCost: 2,
    maximumRipEvents: 1_200,
    maximumIterations: 50_000_000,
    maximumLocalRepairAttempts: 0,
    shuffleSeed: 1,
  })
  let initial = initialSteps.next()
  while (!initial.done) {
    yield initial.value
    initial = initialSteps.next()
  }
  if (!initial.value) return null
  let plans = initial.value
  const sites = new Map(params.fixedViaPointsByConnectionIndex)
  const paths = new Map(
    params.allBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [
            connection.connectionIndex,
            params.sourceEscapePaths?.get(connection.connectionIndex) ?? [
              connection.sourcePoint,
              sites.get(connection.connectionIndex)!,
            ],
          ] as const,
      ),
    ),
  )
  const owners = new Map(
    params.buses.flatMap((bus) =>
      bus.connections.map(
        (connection) =>
          [connection.connectionIndex, { bus, connection }] as const,
      ),
    ),
  )
  const updateSource = (plan: FanoutRoutePlan) => {
    if (!plan.via)
      throw new Error("Source-origin routing lost a required first via")
    sites.set(plan.connectionIndex, plan.via.center)
    const segments = plan.segments.slice(0, plan.sourceEscapeSegmentCount)
    paths.set(plan.connectionIndex, [
      plan.sourcePoint,
      ...segments.map((segment) => segment.end),
    ])
  }
  plans.forEach(updateSource)
  const isOverlong = (plan: FanoutRoutePlan) => {
    const bus = owners.get(plan.connectionIndex)!.bus
    if (bus.connections.length <= 2 || bus.maxLengthSkew === undefined)
      return false
    const minimum = Math.min(
      ...plans
        .filter((other) => other.busId === plan.busId)
        .map((other) => other.length),
    )
    return plan.length > minimum + bus.maxLengthSkew + 1e-7
  }
  for (let pass = 0; pass < 2; pass++) {
    const candidates = plans
      .filter(isOverlong)
      .toSorted((a, b) => b.length - a.length)
      .slice(0, 8)
    let changed = false
    for (const candidate of candidates) {
      const original = plans.find(
        (plan) => plan.connectionIndex === candidate.connectionIndex,
      )!
      if (!isOverlong(original)) continue
      const { bus, connection } = owners.get(original.connectionIndex)!
      const steps = routeReservedViaBusesSteps({
        ...params,
        buses: [{ ...bus, connections: [connection] }],
        transitLayers: [],
        routeFromSourcePads: true,
        sourceLayerTravelCost: 1,
        fixedViaPointsByConnectionIndex: sites,
        sourceEscapePaths: paths,
        acceptedPlans: [
          ...params.acceptedPlans,
          ...plans.filter((plan) => plan !== original),
        ],
        terminals: [
          {
            connection,
            viaPoint: sites.get(connection.connectionIndex)!,
            exitPoint: original.exitPoint,
          },
        ],
        maximumRipEvents: 1,
        maximumIterations: 2_000_000,
        maximumLocalRepairAttempts: 0,
        shuffleSeed: 1,
      })
      let next = steps.next()
      while (!next.done) {
        yield { ...next.value, connectionCount: plans.length }
        next = steps.next()
      }
      const replacement = next.value?.[0]
      if (!replacement || replacement.length >= original.length - 1e-7) continue
      const busPlans = plans.filter((plan) => plan.busId === original.busId)
      const before = busPlans.map((plan) => plan.length)
      const after = busPlans.map((plan) =>
        plan === original ? replacement.length : plan.length,
      )
      if (
        Math.max(...after) - Math.min(...after) >
        Math.max(...before) - Math.min(...before) + 1e-7
      )
        continue
      plans = plans.map((plan) => (plan === original ? replacement : plan))
      updateSource(replacement)
      changed = true
    }
    if (!changed) break
  }
  return {
    plans,
    fixedViaPointsByConnectionIndex: sites,
    sourceEscapePaths: paths,
    sourcePlans: makeSourcePlans(
      { ...params, buses: params.allBuses },
      sites,
      paths,
    ),
  }
}

/** Dense fields turning toward a perpendicular edge need joint first-via ordering. */
export function shouldUseSourceOriginRouting(
  buses: readonly PreparedBus[],
  allowBlindAndBuriedVias: boolean,
): boolean {
  const first = buses[0]
  if (
    !first ||
    allowBlindAndBuriedVias ||
    buses.some(
      (bus) =>
        bus.componentId !== first.componentId ||
        bus.connections.some((c) => c.sourceLayer !== "top"),
    )
  )
    return false
  const boundaries = buses.filter((bus) => bus.termination.type === "boundary")
  const wide = boundaries.filter((bus) => bus.connections.length >= 8)
  const edge = wide[0]?.exitEdge
  if (
    !edge ||
    wide.some((bus) => bus.exitEdge !== edge) ||
    !wide.some(
      (bus) =>
        bus.connections.length >= 16 &&
        bus.allowedLayers?.length === 1 &&
        bus.allowedLayers[0] !== "top",
    )
  )
    return false
  const signalCount = boundaries.reduce(
    (sum, bus) => sum + bus.connections.length,
    0,
  )
  const planeCount = buses
    .filter((bus) => bus.termination.type === "plane")
    .reduce((sum, bus) => sum + bus.connections.length, 0)
  if (planeCount < signalCount) return false
  const points = wide.flatMap((bus) =>
    bus.connections.map((c) => c.sourcePoint),
  )
  const center = points.reduce(
    (sum, p) => ({
      x: sum.x + p.x / points.length,
      y: sum.y + p.y / points.length,
    }),
    { x: 0, y: 0 },
  )
  const bounds = first.componentBounds
  const edges = [
    { horizontal: true, distance: Math.abs(center.x - bounds.minX) },
    { horizontal: true, distance: Math.abs(bounds.maxX - center.x) },
    { horizontal: false, distance: Math.abs(center.y - bounds.minY) },
    { horizontal: false, distance: Math.abs(bounds.maxY - center.y) },
  ].sort((a, b) => a.distance - b.distance)
  if (Math.abs(edges[0]!.distance - edges[1]!.distance) <= 1e-9) return false
  return edges[0]!.horizontal !== (edge === "left" || edge === "right")
}
