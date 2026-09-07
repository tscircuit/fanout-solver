import { buildOutputSimpleRouteJson } from "./build-output"
import {
  matchBusPlanLengths,
  matchBusPlanLengthsWithPeriodicMeanders,
} from "./match-bus-lengths"
import { plansPreserveSourcesAndCorners } from "./plans-preserve-sources-and-corners"
import { repairPeripheralBusLengthsSteps } from "./repair-peripheral-bus-lengths"
import { routeBottomAddressFeedbackSteps } from "./route-bottom-address-feedback"
import type { RouteBusParams } from "./route-bus"
import { routeFreshReservedBusesSteps } from "./route-fresh-reserved-buses"
import { routeSingletonWithLocalPlaneRecoverySteps } from "./route-singleton-with-local-plane-recovery"
import { shortenOverlongSourceEscapeCorners } from "./shorten-overlong-source-corners"
import { shortenSourceEscapePeaks } from "./shorten-source-peaks"
import type { FanoutRoutePlan, PreparedBus } from "./types"
import { validateFanoutSolution } from "./validate-fanout-solution"
import { validateRoutedCopperDrc } from "./validate-routed-copper-drc"

export interface BottomReservedRecoveryParams
  extends Omit<RouteBusParams, "bus" | "targetLayer" | "acceptedPlans"> {
  preparedBuses: readonly PreparedBus[]
  targetLayerByBusId: ReadonlyMap<string, string>
  inputSrj: RouteBusParams["srj"]
  onStage?: (stage: string, plans: readonly FanoutRoutePlan[]) => void
}

/** Derive every source and route from the original prepared buses. */
export function* routeBottomReservedRecoverySteps(
  params: BottomReservedRecoveryParams,
): Generator<unknown, FanoutRoutePlan[] | null, void> {
  if (params.allowBlindAndBuriedVias || params.allowSameNetMerges) return null
  const bus = params.preparedBuses
    .filter((candidate) => candidate.termination.type === "boundary")
    .toSorted((a, b) => b.connections.length - a.connections.length)[0]
  if (
    bus?.exitEdge !== "bottom" ||
    bus.connections.length < 16 ||
    bus.componentObstacles.length < 200 ||
    params.preparedBuses.some((other) => other.componentId !== bus.componentId)
  )
    return null
  const targetLayer = params.targetLayerByBusId.get(bus.busId)
  if (!targetLayer) return null
  const address = yield* routeBottomAddressFeedbackSteps({
    ...params,
    bus,
    targetLayer,
  })
  if (!address) return null
  params.onStage?.("address-physical", address.plans)
  yield { phase: "address-physical-complete" }
  const shortened = shortenOverlongSourceEscapeCorners({
    ...params,
    plans: address.plans,
    sourceEscapes: address.source.sourceEscapes,
  })
  const addressMatching = matchBusPlanLengths({
    ...params,
    plans: shortened.plans,
    preparedBuses: [bus],
    sharedBoundary: bus.sharedBoundary,
    allowMatchingInsideDenseBounds: true,
  })
  // A clear bus can reserve its lanes while other buses are completed; its
  // timing remains mandatory in the final full-layout matching pass.
  const addressPlans = addressMatching.plans ?? shortened.plans
  if (
    !plansPreserveSourcesAndCorners({
      ...params,
      plans: addressPlans,
      sourceEscapes: shortened.sourceEscapes,
    })
  )
    return null
  params.onStage?.(
    addressMatching.plans ? "address-matched" : "address-matching-deferred",
    addressPlans,
  )
  yield {
    phase: addressMatching.plans
      ? "address-matched-complete"
      : "address-matching-deferred",
  }
  let currentSourceEscapes = shortened.sourceEscapes
  const partial = new Map(
    addressPlans.map((plan) => [plan.connectionIndex, plan]),
  )
  let physical = yield* routeFreshReservedBusesSteps({
    ...params,
    buses: params.preparedBuses.filter((other) => other.busId !== bus.busId),
    sourceEscapes: shortened.sourceEscapes,
    sourceBoundary: address.source.sourceBoundary,
    initialPlans: addressPlans.filter((plan) => plan.busId === bus.busId),
    onBusComplete: (completed, plans) => {
      for (const plan of plans) partial.set(plan.connectionIndex, plan)
      params.onStage?.(`bus:${completed.busId}`, plans)
    },
  })
  if (!physical) {
    const pending = params.preparedBuses.filter(
      (candidate) =>
        candidate.termination.type === "boundary" &&
        candidate.connections.some(
          (connection) =>
            partial.get(connection.connectionIndex)?.termination.type !==
            "boundary",
        ),
    )
    if (pending.length !== 1 || pending[0]!.connections.length !== 1)
      return null
    const singleton = pending[0]!
    const singletonLayer = params.targetLayerByBusId.get(singleton.busId)
    if (!singletonLayer) return null
    const recovered = yield* routeSingletonWithLocalPlaneRecoverySteps({
      ...params,
      bus: singleton,
      targetLayer: singletonLayer,
      sourceEscapes: currentSourceEscapes,
      acceptedPlans: [...partial.values()],
    })
    if (!recovered) return null
    physical = recovered.plans
    currentSourceEscapes = recovered.sourceEscapes
  }
  params.onStage?.("physical-complete", physical)
  yield { phase: "physical-complete" }
  const narrowBuses = params.preparedBuses.filter(
    (other) =>
      other.termination.type === "plane" || other.connections.length <= 2,
  )
  const narrowMatching = matchBusPlanLengths({
    ...params,
    plans: physical,
    preparedBuses: narrowBuses,
    sharedBoundary: bus.sharedBoundary,
    allowMatchingInsideDenseBounds: true,
  })
  let narrowPlans = narrowMatching.plans
  if (!narrowPlans && narrowMatching.failedBus?.connections.length === 2)
    narrowPlans = yield* repairPeripheralBusLengthsSteps({
      ...params,
      plans: physical,
      preparedBuses: narrowBuses,
      sharedBoundary: bus.sharedBoundary,
    })
  if (!narrowPlans) return null
  yield { phase: "narrow-matching-complete" }
  if (!addressMatching.plans) {
    // Match smaller outstanding deficits first, then keep that copper fixed
    // while shortening the enclosing source detours.
    const wideBuses = params.preparedBuses.filter(
      (other) =>
        other.busId !== bus.busId &&
        other.termination.type === "boundary" &&
        other.connections.length > 2,
    )
    const deficit = (other: PreparedBus) => {
      const lengths = narrowPlans!
        .filter((plan) => plan.busId === other.busId)
        .map((plan) => plan.length)
      return other.maxLengthSkew === undefined
        ? 0
        : Math.max(
            0,
            Math.max(...lengths) - Math.min(...lengths) - other.maxLengthSkew,
          )
    }
    wideBuses.sort((a, b) => deficit(a) - deficit(b))
    const wideMatching = matchBusPlanLengths({
      ...params,
      plans: narrowPlans,
      preparedBuses: wideBuses,
      sharedBoundary: bus.sharedBoundary,
      allowMatchingInsideDenseBounds: true,
    })
    if (!wideMatching.plans) return null
    narrowPlans = wideMatching.plans
    params.onStage?.("wide-matching-complete", narrowPlans)
    const translated = shortenSourceEscapePeaks({
      ...params,
      plans: narrowPlans,
      sourceEscapes: currentSourceEscapes,
    })
    narrowPlans = translated.plans
    currentSourceEscapes = translated.sourceEscapes
    params.onStage?.("source-peaks-shortened", narrowPlans)
    yield { phase: "source-peaks-shortened" }
  }
  const finalMatchingParams = {
    ...params,
    plans: narrowPlans,
    sharedBoundary: bus.sharedBoundary,
    allowMatchingInsideDenseBounds: true,
  }
  // After ordinary tuning failed, source shortening can expose periodic via-row
  // windows. Try that bounded recovery before repeating the ordinary search.
  const periodic = addressMatching.plans
    ? undefined
    : matchBusPlanLengthsWithPeriodicMeanders(finalMatchingParams)
  const matched = periodic?.plans
    ? periodic
    : matchBusPlanLengths(finalMatchingParams)
  if (
    !matched.plans ||
    !plansPreserveSourcesAndCorners({
      ...params,
      plans: matched.plans,
      sourceEscapes: currentSourceEscapes,
    })
  )
    return null
  const plans = matched.plans
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: params.inputSrj,
    plans,
    layerNames: params.layerNames,
  })
  const validation = validateFanoutSolution({
    inputSrj: params.inputSrj,
    outputSrj,
    plans,
    preparedBuses: params.preparedBuses,
    sharedBoundary: bus.sharedBoundary,
    clearance: params.clearance,
    allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
  })
  if (!validation.valid) return null
  const drc = validateRoutedCopperDrc({
    inputSrj: params.inputSrj,
    routedSrj: outputSrj,
    clearance: params.clearance,
    allowBlindAndBuriedVias: params.allowBlindAndBuriedVias ?? false,
  })
  if (!drc.valid) return null
  params.onStage?.("validated", plans)
  return plans
}
