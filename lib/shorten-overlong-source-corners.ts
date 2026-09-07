import {
  type ShortenSourceCornersParams,
  type ShortenSourceCornersResult,
  shortenSourceEscapeCorners,
} from "./shorten-source-corners"

export interface ShortenOverlongSourceCornersParams
  extends Omit<
    ShortenSourceCornersParams,
    "minimumRetainedLengthByConnectionIndex"
  > {}

/** Preserve already-short source escapes while reducing actual bus outliers. */
export function shortenOverlongSourceEscapeCorners(
  params: ShortenOverlongSourceCornersParams,
): ShortenSourceCornersResult & { selectedConnectionIndices: number[] } {
  const plans = new Map(
    params.plans.map((plan) => [plan.connectionIndex, plan]),
  )
  const floors = new Map<number, number>()
  for (const bus of params.preparedBuses) {
    if (bus.maxLengthSkew === undefined) continue
    const complete = bus.connections.map((connection) =>
      plans.get(connection.connectionIndex),
    )
    if (
      complete.some(
        (plan) => !plan || plan.termination.type !== bus.termination.type,
      )
    )
      continue
    const minimum =
      Math.min(...complete.map((plan) => plan!.length)) + bus.maxLengthSkew
    for (const plan of complete)
      if (plan!.length > minimum + 1e-7)
        floors.set(plan!.connectionIndex, minimum)
  }
  return {
    ...shortenSourceEscapeCorners({
      ...params,
      minimumRetainedLengthByConnectionIndex: floors,
    }),
    selectedConnectionIndices: [...floors.keys()],
  }
}
