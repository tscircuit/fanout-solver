import {
  getExitEdgeForDirection,
  getDirectionForExitEdge,
} from "../boundary-exit"
import { getDeclaredDifferentialPairs } from "../get-declared-differential-pairs"
import { normalizeFanoutPlanCorners } from "../normalize-fanout-plan-corners"
import { packBoundaryBusIntervals } from "../pack-boundary-bus-intervals"
import { routeReservedViaBusesSteps } from "../route-reserved-via-buses"
import { routeViaMinimalWindingAlternativesSteps } from "../route-via-minimal-winding"
import type { FanoutRoutePlan } from "../types"
import { getBoundaryTargetTrack } from "./boundary-tracks"
import { getCachedFanoutPlanClearanceValidator } from "./plan-clearance"
import type { RouteBusBoundaryContext } from "./types"

/** Route automatic TOP sources and their first vias jointly in board-world mm
 * (+X right, +Y up), retaining the original shared boundary and layer domain. */
export function routeAutomaticSourceBoundaryBus(
  context: RouteBusBoundaryContext,
): FanoutRoutePlan[] | null {
  const { bus, targetLayer, traceWidth, clearance } = context
  if (
    context.allowAutomaticSourceBoundaryRecovery !== true ||
    context.allowBlindAndBuriedVias ||
    bus.connections.length === 0 ||
    bus.maxLengthSkew !== undefined ||
    bus.requestedDirection ||
    bus.preferredExit ||
    bus.exitEdge ||
    context.fixedViaPointsByConnectionIndex ||
    context.fixedBoundaryTracksByConnectionIndex ||
    context.sourceEscapePaths ||
    context.reservedVias.length > 0 ||
    context.softReservedVias.length > 0 ||
    bus.connections.some((connection) => connection.sourceLayer !== "top") ||
    getDeclaredDifferentialPairs(context.srj).some((pair) =>
      pair.connectionNames.some((name) =>
        bus.connections.some(
          (connection) => connection.connection.name === name,
        ),
      ),
    )
  )
    return null
  const edge = getExitEdgeForDirection(bus.direction)
  const boundary = bus.sharedBoundary
  const width =
    edge === "left" || edge === "right"
      ? boundary.maxY - boundary.minY
      : boundary.maxX - boundary.minX
  if (
    (bus.connections.length - 1) * (traceWidth + clearance) >
    width - 2 * traceWidth
  )
    return null
  const sourceBus = { ...bus, exitEdge: edge }
  const packingBus = {
    ...sourceBus,
    sharedBoundary: {
      minX: boundary.minX + traceWidth,
      maxX: boundary.maxX - traceWidth,
      minY: boundary.minY + traceWidth,
      maxY: boundary.maxY - traceWidth,
    },
  }
  const desired = bus.connections
    .map((connection) =>
      getBoundaryTargetTrack({
        ...context,
        bus: packingBus,
        connection,
        boundaryDirection: getDirectionForExitEdge(edge),
      }),
    )
    .toSorted((a, b) => a - b)
  if (
    desired.some(
      (track, index) =>
        index > 0 &&
        track - desired[index - 1]! < traceWidth + clearance - 1e-8,
    )
  )
    return null
  const targetLayerByBusId = new Map([[bus.busId, targetLayer]])
  const packed = packBoundaryBusIntervals({
    ...context,
    buses: [packingBus],
    targetLayerByBusId,
  })
  const terminals = bus.connections.map((connection) => {
    const track = packed.tracksByConnectionIndex.get(
      connection.connectionIndex,
    )!
    const exitPoint =
      edge === "left"
        ? { x: boundary.minX, y: track }
        : edge === "right"
          ? { x: boundary.maxX, y: track }
          : edge === "top"
            ? { x: track, y: boundary.maxY }
            : { x: track, y: boundary.minY }
    return { connection, viaPoint: connection.sourcePoint, exitPoint }
  })
  const steps =
    targetLayer === "top"
      ? routeViaMinimalWindingAlternativesSteps(
          {
            ...context,
            bus: sourceBus,
            terminals,
            allowSourceLayerRouting: true,
            maximumRouteOrderAttempts: 1,
            alignGridToPads: true,
            gridStepDivisor: 2,
          },
          1,
        )
      : routeReservedViaBusesSteps({
          ...context,
          allBuses: [sourceBus],
          buses: [sourceBus],
          targetLayerByBusId,
          terminals,
          fixedViaPointsByConnectionIndex: new Map(
            terminals.map((terminal) => [
              terminal.connection.connectionIndex,
              terminal.viaPoint,
            ]),
          ),
          routeFromSourcePads: true,
          maximumIterations: bus.connections.length * 240_000,
          maximumLocalRepairAttempts: 0,
          maximumSourceOriginRepairAttempts: 0,
          transitLayers: (
            bus.routableEscapeLayers ??
            bus.allowedLayers ??
            context.layerNames
          ).filter((layer) => layer !== "top"),
          includeDiagonalNeighbors: true,
          terminalApproachLength: traceWidth + clearance,
        })
  let result = steps.next()
  while (!result.done) result = steps.next()
  if (!result.value) return null
  const routedPlans = targetLayer === "top" ? result.value[0] : result.value
  if (!routedPlans?.length) return null
  const plans = normalizeFanoutPlanCorners({
    ...context,
    inputSrj: context.srj,
    preparedBuses: [sourceBus],
    plans: routedPlans as FanoutRoutePlan[],
    repairSignalSourceCorners: true,
  })
  if (
    !plans ||
    !getCachedFanoutPlanClearanceValidator({
      ...context,
      sharedBoundary: boundary,
    })([...context.acceptedPlans, ...plans])
  )
    return null
  // The derived edge guides this search; it is not an authored exit constraint.
  return plans.map((plan) => ({ ...plan, exitEdge: bus.exitEdge }))
}
