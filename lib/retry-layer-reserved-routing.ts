import type { LayerReservedRoutingProgress } from "./route-layer-reserved-buses"
import type { FanoutRoutePlan } from "./types"

export interface LayerReservedAttemptState {
  reserveFutureApproaches: boolean
  failedNarrowGroup: boolean
}

/**
 * Future approach traces guide first-via placement, but can select a topology
 * that later pairs cannot route or length-match. Retry from fresh source
 * reservations once, only after that specific downstream failure. Successful routes and
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
  }
  const result = yield* attempt(protectedState)
  if (result || !sourceOriginRouting || !protectedState.failedNarrowGroup)
    return result
  return yield* attempt({
    reserveFutureApproaches: false,
    failedNarrowGroup: false,
  })
}
