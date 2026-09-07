import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distance } from "./geometry"
import {
  routeReservedViaBusesSteps,
  type ReservedViaBusesProgress,
} from "./route-reserved-via-buses"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

export interface RepairBusLengthsWithTransitParams {
  inputSrj: SimpleRouteJson
  /** Complete, physically clear plans; only length skew may remain invalid. */
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  /** Restrict cleanup without omitting any source or accepted copper. */
  busIds?: readonly string[]
  maximumConnectionAttempts?: number
  maximumIterationsPerConnection?: number
}

export interface TransitLengthRepairProgress extends ReservedViaBusesProgress {
  busId: string
  connectionName: string
  connectionAttempt: number
}

const EPSILON = 1e-6
const skew = (plans: readonly FanoutRoutePlan[]) =>
  Math.max(...plans.map((plan) => plan.length)) -
  Math.min(...plans.map((plan) => plan.length))

/**
 * Shorten overlong lanes through permitted transit layers while preserving
 * their original first via and exact source/exit. Every other complete route
 * stays hard copper. A bus is returned only when its complete skew is repaired;
 * cancellation or an exhausted search never exposes a partially repaired bus.
 */
export function* repairBusLengthsWithTransitSteps(
  params: RepairBusLengthsWithTransitParams,
): Generator<TransitLengthRepairProgress, FanoutRoutePlan[] | null> {
  const {
    inputSrj,
    preparedBuses,
    layerNames,
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
    maximumConnectionAttempts = 8,
    maximumIterationsPerConnection = 30_000_000,
  } = params
  for (const [name, value] of [
    ["maximumConnectionAttempts", maximumConnectionAttempts],
    ["maximumIterationsPerConnection", maximumIterationsPerConnection],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`FanoutSolver: ${name} must be a positive safe integer`)
  }
  const byIndex = new Map(
    params.plans.map((plan) => [plan.connectionIndex, plan]),
  )
  const connections = preparedBuses.flatMap((bus) => bus.connections)
  if (
    connections.length !== inputSrj.connections.length ||
    byIndex.size !== params.plans.length ||
    byIndex.size !== connections.length ||
    connections.some(
      (connection) =>
        byIndex.get(connection.connectionIndex)?.connectionName !==
        connection.connection.name,
    )
  )
    throw new Error(
      "FanoutSolver: transit length repair requires every original plan",
    )

  const selected = preparedBuses.filter(
    (bus) =>
      bus.termination.type === "boundary" &&
      bus.maxLengthSkew !== undefined &&
      bus.connections.length > 1 &&
      (!params.busIds || params.busIds.includes(bus.busId)),
  )
  let plans = [...params.plans]
  const violating = selected.filter(
    (bus) =>
      skew(plans.filter((plan) => plan.busId === bus.busId)) >
      bus.maxLengthSkew! + EPSILON,
  )
  if (!violating.length) return plans

  const fixed = new Map<number, Point2D>()
  const sourcePaths = new Map<number, readonly Point2D[]>()
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
        (segment, index) =>
          index > 0 &&
          distance(source[index - 1]!.end, segment.start) > EPSILON,
      )
    )
      return null
    fixed.set(connection.connectionIndex, plan.via.center)
    sourcePaths.set(connection.connectionIndex, [
      source[0]!.start,
      ...source.map((segment) => segment.end),
    ])
  }

  let attempts = 0
  for (const bus of violating) {
    let busPlans = plans.filter((plan) => plan.busId === bus.busId)
    if (busPlans.length !== bus.connections.length) return null
    const targetLayer = busPlans[0]!.targetLayer
    const permitted =
      bus.routableEscapeLayers ?? bus.allowedLayers ?? layerNames
    const transitLayers = permitted.filter((layer) => layer !== targetLayer)
    if (
      !permitted.includes(targetLayer) ||
      !transitLayers.length ||
      busPlans.some((plan) => plan.targetLayer !== targetLayer)
    )
      return null
    const tried = new Set<number>()
    while (skew(busPlans) > bus.maxLengthSkew! + EPSILON) {
      const minimum = Math.min(...busPlans.map((plan) => plan.length))
      const original = busPlans
        .filter(
          (plan) =>
            !tried.has(plan.connectionIndex) &&
            plan.length > minimum + bus.maxLengthSkew! + EPSILON,
        )
        .toSorted(
          (a, b) =>
            b.length - a.length || a.connectionIndex - b.connectionIndex,
        )[0]
      if (!original || attempts >= maximumConnectionAttempts) return null
      tried.add(original.connectionIndex)
      const firstVia = original.via!
      if (
        original.planeEndpointTrace !== undefined ||
        original.planeEndpointSegments !== undefined ||
        original.planeEndpointVia !== undefined ||
        firstVia.fromLayer !== original.sourceLayer ||
        firstVia.toLayer !== targetLayer ||
        firstVia.diameter !== viaDiameter ||
        firstVia.holeDiameter !== viaHoleDiameter ||
        firstVia.spanLayers.length !== layerNames.length ||
        !layerNames.every((layer) => firstVia.spanLayers.includes(layer))
      )
        continue
      const connection = bus.connections.find(
        (item) => item.connectionIndex === original.connectionIndex,
      )!
      attempts++
      const steps = routeReservedViaBusesSteps({
        srj: inputSrj,
        allBuses: preparedBuses,
        buses: [{ ...bus, connections: [connection] }],
        targetLayer,
        transitLayers,
        terminals: [
          {
            connection,
            viaPoint: firstVia.center,
            exitPoint: original.exitPoint,
          },
        ],
        fixedViaPointsByConnectionIndex: fixed,
        sourceEscapePaths: sourcePaths,
        acceptedPlans: plans.filter((plan) => plan !== original),
        layerNames,
        traceWidth,
        clearance,
        viaDiameter,
        viaHoleDiameter,
        tightViaChannels: true,
        ripCost: 64,
        shuffleSeed: 1,
        maximumRipEvents: 1,
        maximumIterations: maximumIterationsPerConnection,
      })
      let next = steps.next()
      while (!next.done) {
        yield {
          ...next.value,
          busId: bus.busId,
          connectionName: original.connectionName,
          connectionAttempt: attempts,
        }
        next = steps.next()
      }
      const routed = next.value?.[0]
      if (!routed || routed.length >= original.length - EPSILON) continue
      const sourceCount = original.sourceEscapeSegmentCount ?? 1
      const oldViaIndex = original.trace.route.findIndex(
        (point) => point.route_type === "via",
      )
      const newViaIndex = routed.trace.route.findIndex(
        (point) => point.route_type === "via",
      )
      if (oldViaIndex < 0 || newViaIndex < 0) return null
      const candidate: FanoutRoutePlan = {
        ...original,
        via: firstVia,
        additionalVias: routed.additionalVias,
        segments: [
          ...original.segments.slice(0, sourceCount),
          ...routed.segments.slice(routed.sourceEscapeSegmentCount ?? 1),
        ],
        trace: {
          ...original.trace,
          route: [
            ...original.trace.route.slice(0, oldViaIndex + 1),
            ...routed.trace.route.slice(newViaIndex + 1),
          ],
        },
        length: routed.length,
      }
      const candidateBus = busPlans.map((plan) =>
        plan === original ? candidate : plan,
      )
      // Equal maxima may need several provisional replacements. The full bus
      // must reach its original limit before any repaired plans are returned.
      if (skew(candidateBus) > skew(busPlans) + EPSILON) continue
      plans = plans.map((plan) => (plan === original ? candidate : plan))
      busPlans = candidateBus
    }
  }
  const validation = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: {
      ...inputSrj,
      traces: [
        ...(inputSrj.traces ?? []),
        ...plans.flatMap((plan) => [
          plan.trace,
          ...(plan.planeEndpointTrace ? [plan.planeEndpointTrace] : []),
        ]),
      ],
    },
    clearance,
    allowBlindAndBuriedVias: false,
  })
  return validation.valid ? plans : null
}
