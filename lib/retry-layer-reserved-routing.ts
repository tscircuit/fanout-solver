import type { LayerReservedRoutingProgress } from "./route-layer-reserved-buses"
import type { FanoutRoutePlan } from "./types"

export interface LayerReservedAttemptState {
  reserveFutureApproaches: boolean
  failedNarrowGroup: boolean
  failedWideMatching: boolean
}

/**
 * Future approach traces guide first-via placement, but can select a topology
 * that a wide bus cannot length-match or later pairs cannot route. Retry with
 * fresh source reservations once after either failure. Successful routes and
 * failures during source placement or wide-bus routing keep their first path.
 */
export function* retryLayerReservedRoutingSteps(
  sourceOriginRouting: boolean,
  attempt: (
    state: LayerReservedAttemptState,
  ) => Generator<
    LayerReservedRoutingProgress,
    FanoutRoutePlan[] | null,
    unknown
  >,
): Generator<LayerReservedRoutingProgress, FanoutRoutePlan[] | null, unknown> {
  const protectedState: LayerReservedAttemptState = {
    reserveFutureApproaches: true,
    failedNarrowGroup: false,
    failedWideMatching: false,
  }
  const result = yield* attempt(protectedState)
  if (
    result ||
    !sourceOriginRouting ||
    (!protectedState.failedNarrowGroup && !protectedState.failedWideMatching)
  )
    return result
  return yield* attempt({
    reserveFutureApproaches: false,
    failedNarrowGroup: false,
    failedWideMatching: false,
  })
}
