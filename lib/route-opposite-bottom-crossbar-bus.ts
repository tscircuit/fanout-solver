import { reflectFanoutX } from "./reflect-fanout-x"
import { routeBottomCrossbarBusSteps } from "./route-bottom-crossbar-bus"
import type { RouteBusParams } from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import type { RouteViaMinimalWindingProgress } from "./route-via-minimal-winding"
import type { Bounds, FanoutRoutePlan } from "./types"

/** Use the annulus opposite the requested edge when its nearer source exits are blocked. */
export function* routeOppositeBottomCrossbarBusSteps(
  params: RouteBusParams & {
    sourceEscapes: readonly PeripheralSourceEscape[]
    sourceBoundary: Bounds
  },
): Generator<RouteViaMinimalWindingProgress, FanoutRoutePlan[] | null, void> {
  if (params.bus.exitEdge !== "right") return null
  const mirrored = reflectFanoutX(params)
  const padPitch = Math.min(params.bus.pitchX, params.bus.pitchY)
  const pitch = params.traceWidth + params.clearance
  const portPitch =
    Math.ceil((params.viaDiameter + params.clearance) / pitch) * pitch
  const maximumPortShift = Math.max(
    0,
    Math.min(
      8,
      Math.floor(
        ((mirrored.sourceBoundary.maxX - mirrored.sourceBoundary.minX) / 2 -
          params.bus.connections.length * portPitch -
          pitch) /
          padPitch,
      ),
    ),
  )
  const layouts = [
    undefined,
    { sourcePortOffset: -padPitch, rowOffset: 0, compactRows: false },
    ...[0, 1, 2, 3].map((row) => ({
      sourcePortOffset: -padPitch,
      rowOffset: row * pitch,
      compactRows: true,
    })),
    // Earlier crossbars can occupy the central source ports. Try bounded
    // outward windows that still fit every source port inside the same border.
    ...Array.from(
      { length: maximumPortShift },
      (_, index) => maximumPortShift - index,
    ).flatMap((shift) =>
      [0, 1, 2, 3].map((row) => ({
        sourcePortOffset: shift * padPitch,
        rowOffset: row * pitch,
        compactRows: true,
      })),
    ),
  ]
  let plans: FanoutRoutePlan[] | null = null
  for (const oppositeLayout of layouts) {
    plans = yield* routeBottomCrossbarBusSteps({ ...mirrored, oppositeLayout })
    if (plans) break
  }
  if (!plans) return null
  const byIndex = new Map(
    params.bus.connections.map((connection) => [
      connection.connectionIndex,
      connection,
    ]),
  )
  return reflectFanoutX(plans).map((plan) => ({
    ...plan,
    sourceObstacle: byIndex.get(plan.connectionIndex)!.sourceObstacle,
  }))
}
