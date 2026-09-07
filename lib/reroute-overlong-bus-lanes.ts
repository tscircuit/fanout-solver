import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { distance } from "./geometry"
import { getViaChannelGridPhase } from "./get-via-channel-grid-phase"
import {
  routeViaMinimalWindingAlternativesSteps,
  type RouteViaMinimalWindingProgress,
} from "./route-via-minimal-winding"
import type { FanoutRoutePlan, Point2D, PreparedBus } from "./types"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

export interface RerouteOverlongBusLanesParams {
  inputSrj: SimpleRouteJson
  /** Every connection's physically clear source or completed fanout copper. */
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  selectedBusIds?: ReadonlySet<string>
  layerNames: string[]
  traceWidth: number
  clearance: number
  viaDiameter: number
  viaHoleDiameter: number
  maximumPasses?: number
  maximumConnectionAttempts?: number
  maximumSearchStates?: number
}

export interface OverlongBusLaneProgress
  extends RouteViaMinimalWindingProgress {
  busId: string
  pass: number
  connectionAttempt: number
}

const EPSILON = 1e-6
const skew = (plans: readonly FanoutRoutePlan[]) =>
  Math.max(...plans.map((plan) => plan.length)) -
  Math.min(...plans.map((plan) => plan.length))

/**
 * Revisit overlong lanes after their neighbors free shorter same-layer paths.
 * Every first/additional via, source prefix, exit and other bus stays reserved.
 * This returns complete copper with improved skew; the caller must still match
 * and validate each entire bus before committing it as a successful fanout.
 */
export function* rerouteOverlongBusLanesSteps(
  params: RerouteOverlongBusLanesParams,
): Generator<OverlongBusLaneProgress, FanoutRoutePlan[] | null, unknown> {
  const {
    inputSrj,
    preparedBuses,
    layerNames,
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
    maximumPasses = 3,
    maximumConnectionAttempts = 24,
    maximumSearchStates = 1_200_000,
  } = params
  for (const [name, value] of [
    ["maximumPasses", maximumPasses],
    ["maximumConnectionAttempts", maximumConnectionAttempts],
    ["maximumSearchStates", maximumSearchStates],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`FanoutSolver: ${name} must be a positive safe integer`)
  }
  const byIndex = new Map(
    params.plans.map((plan) => [plan.connectionIndex, plan]),
  )
  const connections = preparedBuses.flatMap((bus) => bus.connections)
  if (
    byIndex.size !== params.plans.length ||
    byIndex.size !== inputSrj.connections.length ||
    connections.length !== byIndex.size ||
    connections.some(
      (connection) =>
        byIndex.get(connection.connectionIndex)?.connectionName !==
        connection.connection.name,
    )
  )
    throw new Error(
      "FanoutSolver: overlong-lane rerouting requires every original plan",
    )

  const routingBuses = preparedBuses.filter(
    (bus) =>
      bus.termination.type === "boundary" &&
      (!params.selectedBusIds || params.selectedBusIds.has(bus.busId)),
  )
  const selected = routingBuses.filter(
    (bus) => bus.maxLengthSkew !== undefined && bus.connections.length > 1,
  )
  let plans = [...params.plans]
  const sourcePaths = new Map<number, readonly Point2D[]>()
  for (const plan of plans) {
    if (!plan.via) continue
    const source = plan.segments.slice(0, plan.sourceEscapeSegmentCount ?? 1)
    if (
      !source.length ||
      source.some((segment) => segment.layer !== plan.sourceLayer) ||
      distance(source[0]!.start, plan.sourcePoint) > EPSILON ||
      distance(source.at(-1)!.end, plan.via.center) > EPSILON ||
      source.some(
        (segment, index) =>
          index > 0 &&
          distance(source[index - 1]!.end, segment.start) > EPSILON,
      )
    )
      continue
    sourcePaths.set(plan.connectionIndex, [
      source[0]!.start,
      ...source.map((segment) => segment.end),
    ])
  }
  const phaseByLayer = new Map<string, Point2D>()
  const gridStep = (traceWidth + clearance) / 2
  let attempts = 0,
    changed = false
  for (const bus of selected) {
    let busPlans = plans.filter((plan) => plan.busId === bus.busId)
    const originalSkew = skew(busPlans)
    if (originalSkew <= bus.maxLengthSkew! + EPSILON) continue
    const beforeBus = [...plans]
    for (let pass = 0; pass < maximumPasses; pass++) {
      const minimum = Math.min(...busPlans.map((plan) => plan.length))
      let passChanged = false
      const overlong = busPlans
        .filter((plan) => plan.length > minimum + bus.maxLengthSkew! + EPSILON)
        .toSorted(
          (a, b) =>
            b.length - a.length || a.connectionIndex - b.connectionIndex,
        )
      for (const original of overlong) {
        if (attempts >= maximumConnectionAttempts) break
        const targetLayer = original.targetLayer,
          via = original.via,
          sourceCount = original.sourceEscapeSegmentCount ?? 1
        // A same-layer rewrite cannot replace existing transitions or a plane
        // endpoint branch. Their complete copper remains a hard reservation.
        if (
          !via ||
          (original.additionalVias?.length ?? 0) > 0 ||
          original.planeEndpointTrace ||
          original.planeEndpointVia ||
          !sourcePaths.has(original.connectionIndex) ||
          via.fromLayer !== original.sourceLayer ||
          via.toLayer !== targetLayer ||
          via.diameter !== viaDiameter ||
          via.holeDiameter !== viaHoleDiameter ||
          via.spanLayers.length !== layerNames.length ||
          !layerNames.every((layer) => via.spanLayers.includes(layer)) ||
          !(
            bus.routableEscapeLayers ??
            bus.allowedLayers ??
            layerNames
          ).includes(targetLayer) ||
          original.segments
            .slice(sourceCount)
            .some((segment) => segment.layer !== targetLayer)
        )
          continue
        const connection = bus.connections.find(
          (candidate) => candidate.connectionIndex === original.connectionIndex,
        )!
        let gridOrigin = phaseByLayer.get(targetLayer)
        if (!gridOrigin) {
          gridOrigin = getViaChannelGridPhase({
            vias: plans.flatMap((plan) =>
              [plan.via, ...(plan.additionalVias ?? []), plan.planeEndpointVia]
                .filter((candidate) =>
                  candidate?.spanLayers.includes(targetLayer),
                )
                .map((candidate) => ({
                  connectionIndex: plan.connectionIndex,
                  center: candidate!.center,
                  diameter: candidate!.diameter,
                })),
            ),
            activeConnectionIndices: new Set(
              routingBuses.flatMap((candidate) =>
                candidate.connections
                  .filter(
                    (entry) =>
                      byIndex.get(entry.connectionIndex)?.targetLayer ===
                      targetLayer,
                  )
                  .map((entry) => entry.connectionIndex),
              ),
            ),
            traceWidth,
            clearance,
            gridStep,
          })
          phaseByLayer.set(targetLayer, gridOrigin)
        }
        attempts++
        const steps = routeViaMinimalWindingAlternativesSteps(
          {
            srj: inputSrj,
            bus,
            targetLayer,
            terminals: [
              {
                connection,
                viaPoint: via.center,
                exitPoint: original.exitPoint,
              },
            ],
            acceptedPlans: plans.filter(
              (plan) => plan.connectionIndex !== original.connectionIndex,
            ),
            layerNames,
            traceWidth,
            clearance,
            viaDiameter,
            viaHoleDiameter,
            allowBlindAndBuriedVias: false,
            sourceEscapePaths: sourcePaths,
            gridStepDivisor: 2,
            gridStep,
            gridOrigin,
            alignGridToPads: true,
            heuristicWeight: 1,
            maximumRouteOrderAttempts: 1,
            maximumSearchStates,
            preferTargetDirectedLaneBias: true,
          },
          1,
          false,
        )
        let next = steps.next()
        while (!next.done) {
          yield {
            ...next.value,
            busId: bus.busId,
            pass,
            connectionAttempt: attempts,
          }
          next = steps.next()
        }
        const candidate = next.value[0]?.[0]
        if (!candidate || candidate.length >= original.length - EPSILON)
          continue
        const currentBusPlans = plans.filter((plan) => plan.busId === bus.busId)
        const candidateBusPlans = currentBusPlans.map((plan) =>
          plan.connectionIndex === original.connectionIndex ? candidate : plan,
        )
        // A shorter lane can become the new minimum and still improve the
        // complete bus. Permit tied maxima to shorten without increasing skew;
        // the whole bus must improve strictly before any changes are retained.
        if (skew(candidateBusPlans) > skew(currentBusPlans) + EPSILON) continue
        const originalViaIndex = original.trace.route.findIndex(
          (point) => point.route_type === "via",
        )
        const candidateViaIndex = candidate.trace.route.findIndex(
          (point) => point.route_type === "via",
        )
        if (originalViaIndex < 0 || candidateViaIndex < 0) return null
        const route = [
          ...original.trace.route.slice(0, originalViaIndex + 1),
          ...candidate.trace.route.slice(candidateViaIndex + 1),
        ]
        route[route.length - 1] = original.trace.route.at(-1)!
        const replacement: FanoutRoutePlan = {
          ...original,
          trace: { ...original.trace, route },
          segments: [
            ...original.segments.slice(0, sourceCount),
            ...candidate.segments.slice(
              candidate.sourceEscapeSegmentCount ?? 1,
            ),
          ],
          length: candidate.length,
        }
        plans = plans.map((plan) =>
          plan.connectionIndex === original.connectionIndex
            ? replacement
            : plan,
        )
        passChanged = true
      }
      busPlans = plans.filter((plan) => plan.busId === bus.busId)
      if (!passChanged || attempts >= maximumConnectionAttempts) break
    }
    if (skew(busPlans) < originalSkew - EPSILON) changed = true
    else plans = beforeBus
    if (attempts >= maximumConnectionAttempts) break
  }
  if (!changed) return plans
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
