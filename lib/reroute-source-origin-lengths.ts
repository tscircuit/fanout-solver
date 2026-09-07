import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distance } from "./geometry"
import {
  routeReservedViaBusesSteps,
  type ReservedViaBusesProgress,
} from "./route-reserved-via-buses"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

export interface RerouteSourceOriginLengthsParams {
  inputSrj: SimpleRouteJson
  /** Include every original connection, with unfinished routes as source prefixes. */
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  bus: PreparedBus
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
}

const EPSILON = 1e-6
const skew = (plans: readonly FanoutRoutePlan[]) =>
  Math.max(...plans.map((plan) => plan.length)) -
  Math.min(...plans.map((plan) => plan.length))

/**
 * Reconsider first vias for an intact mismatched pair, or at most two overlong
 * lanes of a wider bus. Other sources and completed copper remain hard. The
 * returned full candidate is provisional: its complete bus must still pass
 * length matching before its new source reservations can be committed.
 */
export function* rerouteSourceOriginLengthsSteps(
  params: RerouteSourceOriginLengthsParams,
): Generator<ReservedViaBusesProgress, FanoutRoutePlan[] | null> {
  const { plans, bus, preparedBuses, inputSrj } = params
  const connections = preparedBuses.flatMap((b) => b.connections)
  const byIndex = new Map(plans.map((plan) => [plan.connectionIndex, plan]))
  if (
    connections.length !== inputSrj.connections.length ||
    byIndex.size !== plans.length ||
    byIndex.size !== connections.length ||
    connections.some(
      (c) =>
        byIndex.get(c.connectionIndex)?.connectionName !== c.connection.name,
    )
  )
    throw new Error(
      "FanoutSolver: source-origin length repair requires every original plan",
    )
  const own = bus.connections.map((c) => byIndex.get(c.connectionIndex)!)
  if (
    bus.termination.type !== "boundary" ||
    bus.maxLengthSkew === undefined ||
    own.length < 2 ||
    skew(own) <= bus.maxLengthSkew + EPSILON
  )
    return null
  const targetLayer = own[0]!.targetLayer
  if (own.some((plan) => plan.targetLayer !== targetLayer)) return null
  const minimum = Math.min(...own.map((plan) => plan.length))
  const selected = new Set(
    (own.length === 2
      ? own
      : own
          .filter(
            (plan) => plan.length > minimum + bus.maxLengthSkew! + EPSILON,
          )
          .toSorted(
            (a, b) =>
              b.length - a.length || a.connectionIndex - b.connectionIndex,
          )
          .slice(0, 2)
    ).map((plan) => plan.connectionIndex),
  )
  if (!selected.size) return null
  const fixed = new Map<number, Point2D>()
  const paths = new Map<number, readonly Point2D[]>()
  for (const connection of connections) {
    const plan = byIndex.get(connection.connectionIndex)!
    if (!plan.via) return null
    const source = plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1)
    if (
      !source.length ||
      source.some((segment) => segment.layer !== connection.sourceLayer) ||
      distance(source[0]!.start, connection.sourcePoint) > EPSILON ||
      distance(source.at(-1)!.end, plan.via.center) > EPSILON ||
      source.some(
        (segment, i) =>
          i > 0 && distance(source[i - 1]!.end, segment.start) > EPSILON,
      )
    )
      return null
    fixed.set(connection.connectionIndex, plan.via.center)
    paths.set(connection.connectionIndex, [
      connection.sourcePoint,
      ...source.map((s) => s.end),
    ])
  }
  const selectedConnections = bus.connections.filter((c) =>
    selected.has(c.connectionIndex),
  )
  const routed = yield* routeReservedViaBusesSteps({
    ...params,
    srj: inputSrj,
    allBuses: preparedBuses,
    buses: [{ ...bus, connections: selectedConnections }],
    targetLayer,
    transitLayers: [],
    terminals: selectedConnections.map((connection) => ({
      connection,
      viaPoint: fixed.get(connection.connectionIndex)!,
      exitPoint: byIndex.get(connection.connectionIndex)!.exitPoint,
    })),
    fixedViaPointsByConnectionIndex: fixed,
    sourceEscapePaths: paths,
    acceptedPlans: plans.filter((plan) => !selected.has(plan.connectionIndex)),
    routeFromSourcePads: true,
    sourceLayerTravelCost: 1,
    tightViaChannels: true,
    ripCost: 256,
    shuffleSeed: 1,
    maximumRipEvents: 40,
    maximumIterations: 5_000_000,
    maximumLocalRepairAttempts: 0,
  })
  if (!routed || routed.length !== selected.size) return null
  const replacements = new Map(
    routed.map((plan) => [plan.connectionIndex, plan]),
  )
  const candidate = plans.map(
    (plan) => replacements.get(plan.connectionIndex) ?? plan,
  )
  if (
    skew(own.map((plan) => replacements.get(plan.connectionIndex) ?? plan)) >=
    skew(own) - EPSILON
  )
    return null
  const validation = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: {
      ...inputSrj,
      traces: [
        ...(inputSrj.traces ?? []),
        ...candidate.flatMap((plan) => [
          plan.trace,
          ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance: params.clearance,
    allowBlindAndBuriedVias: false,
  })
  return validation.valid ? candidate : null
}
