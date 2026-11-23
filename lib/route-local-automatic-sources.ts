import {
  getDirectionForExitEdge,
  getExitEdgeForDirection,
} from "./boundary-exit"
import {
  routeReservedViaBusesSteps,
  type ReservedViaBusesYield,
} from "./route-reserved-via-buses"
import type { RouteBusParams } from "./route-bus"
import type { FanoutEdge, FanoutRoutePlan, PreparedBus } from "./types"

type Params = Omit<RouteBusParams, "bus" | "targetLayer" | "acceptedPlans"> & {
  buses: readonly PreparedBus[]
  plans: readonly FanoutRoutePlan[]
  escapeLayers: readonly string[]
}

/** Re-negotiate three original singleton sources through the existing native
 * router. Other copper stays hard; real terminal identities and rules remain. */
export function* routeLocalAutomaticSourcesSteps(
  params: Params,
): Generator<ReservedViaBusesYield, FanoutRoutePlan[] | null, unknown> {
  const { buses, plans } = params
  if (
    buses.length !== 3 ||
    new Set(buses.map((bus) => bus.busId)).size !== 3 ||
    buses.some(
      (b) =>
        b.connections.length !== 1 ||
        b.exitEdge ||
        b.requestedDirection ||
        b.preferredExit ||
        b.maxLengthSkew !== undefined ||
        b.termination.type !== "boundary",
    )
  )
    return null
  const traceWidth = buses[0]!.traceWidth ?? params.traceWidth
  if (buses.some((b) => (b.traceWidth ?? params.traceWidth) !== traceWidth))
    return null
  const ids = new Set(buses.map((b) => b.busId)),
    acceptedPlans = plans.filter((p) => !ids.has(p.busId))
  const boundary = buses[0]!.sharedBoundary
  const onEdge = (point: { x: number; y: number }): FanoutEdge =>
    Math.abs(point.x - boundary.minX) < 1e-7
      ? "left"
      : Math.abs(point.x - boundary.maxX) < 1e-7
        ? "right"
        : Math.abs(point.y - boundary.minY) < 1e-7
          ? "bottom"
          : "top"
  const terminals = buses.map((bus) => {
    const old = plans.find((p) => p.busId === bus.busId),
      connection = bus.connections[0]!,
      edge = old
        ? onEdge(old.exitPoint)
        : getExitEdgeForDirection(bus.direction)
    const desired = old?.exitPoint ?? connection.targetPoint
    const horizontal = edge === "left" || edge === "right"
    const track = Math.max(
      (horizontal ? boundary.minY : boundary.minX) + traceWidth,
      Math.min(
        (horizontal ? boundary.maxY : boundary.maxX) - traceWidth,
        horizontal ? desired.y : desired.x,
      ),
    )
    const exitPoint =
      edge === "left"
        ? { x: boundary.minX, y: track }
        : edge === "right"
          ? { x: boundary.maxX, y: track }
          : edge === "bottom"
            ? { x: track, y: boundary.minY }
            : { x: track, y: boundary.maxY }
    return { connection, viaPoint: connection.sourcePoint, exitPoint, edge }
  })
  const sourceBuses = buses.map((bus, index) => ({
    ...bus,
    exitEdge: terminals[index]!.edge,
    direction: getDirectionForExitEdge(terminals[index]!.edge),
  }))
  const layers = params.escapeLayers.filter((l) => l !== "top")
  for (const targetLayer of layers) {
    const targetLayerByBusId = new Map(
      sourceBuses.map((bus, index) => {
        const old = plans.find((p) => p.busId === bus.busId)
        return [
          bus.busId,
          old && old.targetLayer !== "top"
            ? old.targetLayer
            : layers[(layers.indexOf(targetLayer) + index) % layers.length]!,
        ]
      }),
    )
    if (
      sourceBuses.some(
        (bus) =>
          !(
            bus.routableEscapeLayers ??
            bus.allowedLayers ??
            params.layerNames
          ).includes(targetLayerByBusId.get(bus.busId)!),
      )
    )
      continue
    const steps = routeReservedViaBusesSteps({
      ...params,
      traceWidth,
      allBuses: sourceBuses,
      buses: sourceBuses,
      targetLayer,
      targetLayerByBusId,
      terminals,
      fixedViaPointsByConnectionIndex: new Map(
        terminals.map((t) => [t.connection.connectionIndex, t.viaPoint]),
      ),
      acceptedPlans,
      routeFromSourcePads: true,
      transitLayers: layers,
      includeDiagonalNeighbors: true,
      terminalApproachLength: traceWidth + params.clearance,
      maximumIterations: buses.length * 240_000,
      maximumLocalRepairAttempts: 0,
      maximumSourceOriginRepairAttempts: 0,
    })
    let next = steps.next()
    while (!next.done) {
      const output = yield next.value
      next = steps.next(output)
    }
    if (!next.value) continue
    return [
      ...acceptedPlans,
      ...next.value.map((plan) => ({
        ...plan,
        exitEdge: buses.find((b) => b.busId === plan.busId)!.exitEdge,
      })),
    ]
  }
  return null
}
