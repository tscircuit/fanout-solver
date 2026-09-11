import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getCornerBandSide } from "./boundary-exit"
import { getFanoutPlanSkew } from "./get-fanout-plan-effective-length"
import { matchBusPlanLengths } from "./match-bus-lengths"
import type { RouteBusParams } from "./route-bus"
import {
  routeViaMinimalWindingAlternativesSteps,
  type RouteViaMinimalWindingProgress,
} from "./route-via-minimal-winding"
import type { Bounds, FanoutRoutePlan, PreparedBus } from "./types"

interface Params
  extends Omit<RouteBusParams, "bus" | "targetLayer" | "acceptedPlans"> {
  inputSrj: SimpleRouteJson
  sharedBoundary: Bounds
  preparedBuses: readonly PreparedBus[]
  plans: readonly FanoutRoutePlan[]
}

/** Move a pair within its boundary band when its first route leaves no tuning room. */
export function* repairPeripheralBusLengthsSteps(
  params: Params,
): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan[] | null, void> {
  const match = (
    plans: readonly FanoutRoutePlan[],
    buses = params.preparedBuses,
  ) =>
    matchBusPlanLengths({
      plans,
      preparedBuses: buses,
      inputSrj: params.inputSrj,
      sharedBoundary: params.sharedBoundary,
      clearance: params.clearance,
      allowBlindAndBuriedVias: params.allowBlindAndBuriedVias,
      allowSameNetMerges: params.allowSameNetMerges,
    })
  const skew = getFanoutPlanSkew
  const repaired = new Set<string>()
  let current = [...params.plans]
  while (repaired.size < 3) {
    const matched = match(current)
    if (matched.plans) return matched.plans
    const bus = matched.failedBus
    if (
      repaired.has(bus.busId) ||
      bus.connections.length !== 2 ||
      bus.termination.type !== "boundary" ||
      !bus.exitEdge
    )
      return null
    repaired.add(bus.busId)
    const own = current.filter((plan) => plan.busId === bus.busId)
    if (
      own.length !== 2 ||
      own.some((plan) => !plan.via || plan.additionalVias?.length) ||
      own[0]!.targetLayer !== own[1]!.targetLayer
    )
      return null
    const accepted = current.filter((plan) => plan.busId !== bus.busId)
    const sourceEscapePaths = new Map(
      own.map((plan) => [
        plan.connectionIndex,
        [
          plan.sourcePoint,
          ...plan.segments
            .slice(0, plan.sourceEscapeSegmentCount ?? 1)
            .map((segment) => segment.end),
        ],
      ]),
    )
    const horizontal = bus.exitEdge === "left" || bus.exitEdge === "right"
    const axis = horizontal ? "y" : "x"
    const minimum = horizontal
      ? params.sharedBoundary.minY
      : params.sharedBoundary.minX
    const maximum = horizontal
      ? params.sharedBoundary.maxY
      : params.sharedBoundary.maxX
    const middle = (minimum + maximum) / 2
    const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    const pitch = params.traceWidth + params.clearance
    const initialSkew = skew(own)
    const candidates: FanoutRoutePlan[][] = []
    let replacement: FanoutRoutePlan[] | null = null
    search: for (const multiplier of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const offset = multiplier * pitch
      if (
        own.some((plan) => {
          const track = plan.exitPoint[axis] + offset
          return (
            track < minimum + params.traceWidth / 2 ||
            track > maximum - params.traceWidth / 2 ||
            (side === "minimum" && track >= middle) ||
            (side === "maximum" && track <= middle)
          )
        })
      )
        continue
      for (const laneBias of [0, -1, 1] as const) {
        for (const routeOrder of [
          [0, 1],
          [1, 0],
        ]) {
          const alternatives = yield* routeViaMinimalWindingAlternativesSteps(
            {
              ...params,
              bus,
              targetLayer: own[0]!.targetLayer,
              acceptedPlans: accepted,
              terminals: bus.connections.map((connection) => {
                const original = own.find(
                  (plan) => plan.connectionIndex === connection.connectionIndex,
                )!
                return {
                  connection,
                  viaPoint: original.via!.center,
                  exitPoint: {
                    ...original.exitPoint,
                    [axis]: original.exitPoint[axis] + offset,
                  },
                }
              }),
              sourceEscapePaths,
              reservedVias: undefined,
              gridStep: pitch / 2,
              gridStepDivisor: 2,
              alignGridToPads: true,
              maximumRouteOrderAttempts: 1,
              routeOrder,
              laneBias,
            },
            1,
            false,
          )
          if (!alternatives.length || skew(alternatives[0]!) >= initialSkew)
            continue
          const candidate = alternatives[0]!.map((plan) => ({
            ...plan,
            cornerBandSide: side,
          }))
          candidates.push(candidate)
          // A small remaining deficit is inexpensive to tune. Larger deficits
          // are attempted below after collecting the best available geometry.
          if (skew(candidate) > 2 * bus.maxLengthSkew!) continue
          const tuned = match([...accepted, ...candidate], [bus])
          if (!tuned.plans) continue
          replacement = tuned.plans
          break search
        }
      }
    }
    if (!replacement) {
      for (const candidate of candidates
        .toSorted((a, b) => skew(a) - skew(b))
        .slice(0, 3)) {
        const tuned = match([...accepted, ...candidate], [bus])
        if (!tuned.plans) continue
        replacement = tuned.plans
        break
      }
    }
    if (!replacement) return null
    current = replacement
  }
  return match(current).plans
}
