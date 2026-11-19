import { getDirectionForExitEdge } from "../boundary-exit"
import { circleFitsInsideObstacle } from "../geometry"
import { getDogboneSideVariants } from "../get-dogbone-side-variants"
import { matchComponentDogboneViaSites } from "../match-component-dogbone-via-sites"
import type { PreparedConnection } from "../types"
import {
  getCornerLaneOffsets,
  getDistributedBoundaryTargetTracks,
} from "./boundary-tracks"
import { allowsViaInPad, getCornerSide } from "./directions"
import { getMixedDogboneTerminalPatterns } from "./get-mixed-dogbone-terminal-patterns"
import { getPlanSegments, getPlanVias } from "./plan-copper"
import { getInitialViaPoint } from "./source-escape"
import type {
  CoordinatedTerminalPattern,
  RouteBusBoundaryContext,
} from "./types"
import { getWindingTargetOrders } from "./winding-target-orders"

export function getCoordinatedTerminalPatterns(
  context: RouteBusBoundaryContext,
): CoordinatedTerminalPattern[] {
  const {
    srj,
    bus,
    targetLayer,
    acceptedPlans,
    layerNames,
    traceWidth,
    viaDiameter,
    viaHoleDiameter,
    clearance,
    allowBlindAndBuriedVias,
    fixedViaPointsByConnectionIndex,
    reservedVias,
    alignWindingGridToPads,
    fixedViaFallbackRouteOrderAttempts,
    allowFixedViaReservedExitFallback,
    cornerExitLaneOffset,
    viaHandednesses,
    cornerLaneOffsets,
  } = context
  if (!bus.exitEdge)
    throw new Error("FanoutSolver: coordinated terminals require an exit edge")
  const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
  const cornerSide = getCornerSide(bus)
  const canUseViaInPadTerminals =
    allowsViaInPad(srj) &&
    bus.connections.every((preparedConnection) =>
      circleFitsInsideObstacle({
        center: preparedConnection.sourcePoint,
        diameter: viaDiameter,
        obstacle: preparedConnection.sourceObstacle,
      }),
    )
  const maximumThroughAllRouteOrderAttempts = 24
  const usesDistributedWindingTargets = Boolean(
    cornerSide ||
      getDistributedBoundaryTargetTracks({
        bus,
        boundaryDirection,
        traceWidth,
        clearance,
      }),
  )
  const windingTargetOrders = getWindingTargetOrders({
    bus,
    boundaryDirection,
    layerNames,
    targetLayer,
  })
  const windingTargetOrderCount = windingTargetOrders.orders.length
  const ordinaryWindingTargetOrderCount = usesDistributedWindingTargets
    ? windingTargetOrders.ordinaryOrderCount
    : 1
  const uniformDogboneTerminalPatterns: CoordinatedTerminalPattern[] =
    viaHandednesses.map((viaHandedness) => ({
      label: `uniform-${viaHandedness}`,
      useViaInPad: false,
      getViaHandedness: () => viaHandedness,
      maximumRouteOrderAttempts: allowBlindAndBuriedVias
        ? undefined
        : maximumThroughAllRouteOrderAttempts,
    }))
  const mixedDogboneTerminalPatterns = getMixedDogboneTerminalPatterns(context)
  const viaInPadTerminalPattern = {
    label: "via-in-pad",
    useViaInPad: true,
    getViaHandedness: () => 0 as const,
  }
  const coordinatedViaPoints =
    fixedViaPointsByConnectionIndex ??
    (!allowBlindAndBuriedVias &&
    (bus.connections.length >= 8 ||
      getDistributedBoundaryTargetTracks({
        bus,
        boundaryDirection,
        traceWidth,
        clearance,
      })) &&
    reservedVias.length === 0
      ? matchComponentDogboneViaSites([bus], {
          viaDiameter,
          viaHoleDiameter,
          traceWidth,
          clearance,
          additionalObstacles: srj.obstacles,
          blockingSegments: acceptedPlans.flatMap((plan) =>
            getPlanSegments(plan).map((segment) => ({
              connectionIndex: plan.connectionIndex,
              segment,
            })),
          ),
          blockingVias: acceptedPlans.flatMap((plan) =>
            getPlanVias(plan).map((via) => ({
              connectionIndex: plan.connectionIndex,
              ...via.center,
              center: via.center,
              diameter: via.diameter,
              spanLayers: via.spanLayers,
            })),
          ),
        })
      : null)
  const fixedViaTerminalPatterns: CoordinatedTerminalPattern[] =
    coordinatedViaPoints
      ? [
          ...Array.from(
            { length: ordinaryWindingTargetOrderCount },
            (_, windingOrderIndex) => ({
              label: `component-matched-vias-winding-${windingOrderIndex}`,
              useViaInPad: false,
              getViaHandedness: () => 0 as const,
              getViaPoint: (connection: PreparedConnection) =>
                coordinatedViaPoints.get(connection.connectionIndex)!,
              maximumRouteOrderAttempts: 1,
              windingOrderIndex,
              preferTargetDirectedLaneBias: true,
            }),
          ),
          {
            label: "component-matched-vias-fallback",
            useViaInPad: false,
            getViaHandedness: () => 0,
            getViaPoint: (connection) =>
              coordinatedViaPoints.get(connection.connectionIndex)!,
            // Preserve the existing bounded search after every inexpensive
            // layer-interleave candidate has had one deterministic attempt.
            maximumRouteOrderAttempts: fixedViaFallbackRouteOrderAttempts,
            windingOrderIndex: 0,
            preferTargetDirectedLaneBias: true,
          },
          // Keep ordinary fixed-site attempts first. Forward retries reserve
          // future exits so an earlier lane cannot close their final gap.
          ...(!getCornerSide(bus) && windingTargetOrderCount > 1
            ? Array.from(
                { length: windingTargetOrderCount },
                (_, windingOrderIndex) =>
                  [true, false].map((preferTargetDirectedLaneBias) => ({
                    label: `expanded-winding-${windingOrderIndex}-${preferTargetDirectedLaneBias}`,
                    useViaInPad: false,
                    getViaHandedness: () => 0 as const,
                    getViaPoint: (connection: PreparedConnection) =>
                      coordinatedViaPoints.get(connection.connectionIndex)!,
                    maximumRouteOrderAttempts: 1,
                    windingOrderIndex,
                    preferTargetDirectedLaneBias,
                    reserveTerminalExitPoints: !preferTargetDirectedLaneBias,
                    allowLayerInterleaving: true,
                  })),
              ).flat()
            : []),
          // A single-layer target permutation can also let an early lane
          // close a future terminal's exit gap. Keep the original attempts
          // first, then retry the same fixed sites with every exit reserved.
          ...(allowFixedViaReservedExitFallback &&
          fixedViaPointsByConnectionIndex &&
          !getCornerSide(bus) &&
          windingTargetOrderCount === 1 &&
          bus.connections.length > 2
            ? [true, false].map((preferTargetDirectedLaneBias) => ({
                label: `fixed-vias-reserved-exits-${preferTargetDirectedLaneBias}`,
                useViaInPad: false,
                getViaHandedness: () => 0 as const,
                getViaPoint: (connection: PreparedConnection) =>
                  coordinatedViaPoints.get(connection.connectionIndex)!,
                maximumRouteOrderAttempts: Math.min(
                  maximumThroughAllRouteOrderAttempts,
                  fixedViaFallbackRouteOrderAttempts,
                ),
                windingOrderIndex: 0,
                preferTargetDirectedLaneBias,
                reserveTerminalExitPoints: true,
              }))
            : []),
        ]
      : []
  const planeTerminationsAlreadyOccupyTheFanout = acceptedPlans.some(
    (plan) => plan.termination.type === "plane",
  )
  const acceptedBoundaryPlansExist = acceptedPlans.some(
    (plan) => plan.termination.type === "boundary",
  )
  const dogboneTerminalPatterns =
    acceptedBoundaryPlansExist && !allowBlindAndBuriedVias
      ? [...mixedDogboneTerminalPatterns, ...uniformDogboneTerminalPatterns]
      : [...uniformDogboneTerminalPatterns, ...mixedDogboneTerminalPatterns]
  const unreservedTerminalPatterns: CoordinatedTerminalPattern[] =
    canUseViaInPadTerminals
      ? planeTerminationsAlreadyOccupyTheFanout
        ? [viaInPadTerminalPattern, ...dogboneTerminalPatterns]
        : [...dogboneTerminalPatterns, viaInPadTerminalPattern]
      : dogboneTerminalPatterns
  // Automatically matched sites are candidates, not caller reservations.
  // Keep the ordinary dogbone patterns available before adding crossover
  // vias when that first site assignment cannot route the complete bus.
  const terminalPatterns: CoordinatedTerminalPattern[] =
    fixedViaPointsByConnectionIndex
      ? fixedViaTerminalPatterns
      : [...fixedViaTerminalPatterns, ...unreservedTerminalPatterns]
  if (
    !fixedViaPointsByConnectionIndex &&
    !allowBlindAndBuriedVias &&
    bus.connections.length > 1 &&
    bus.connections.every(
      (connection) => connection.sourceLayer !== targetLayer,
    ) &&
    viaHandednesses.includes(-1) &&
    viaHandednesses.includes(1)
  ) {
    // Keep the existing successful routes unchanged. Only after those site
    // assignments fail, try local inward dogbones that reopen a channel
    // closed by one or two pads in the same source row.
    const variants = getDogboneSideVariants(bus.connections, bus.direction)
    for (const handedness of viaHandednesses) {
      for (const flippedIndices of variants) {
        terminalPatterns.push({
          label: `local-dogbone-repair-${handedness}-${flippedIndices.join("-")}`,
          useViaInPad: false,
          getViaHandedness: () => handedness,
          maximumRouteOrderAttempts: 6,
          localDogboneRepair: true,
          getViaPoint: (connection) => {
            const point = getInitialViaPoint({
              preparedConnection: connection,
              bus,
              targetLayer,
              traceWidth,
              viaDiameter,
              clearance,
              viaHandedness: handedness,
            })
            if (!flippedIndices.includes(connection.connectionIndex))
              return point
            return bus.direction === "up" || bus.direction === "down"
              ? { x: point.x, y: 2 * connection.sourcePoint.y - point.y }
              : { x: 2 * connection.sourcePoint.x - point.x, y: point.y }
          },
        })
      }
    }
  }
  if (
    alignWindingGridToPads &&
    cornerSide &&
    cornerExitLaneOffset === undefined
  ) {
    const layerLocalExitOffset = getCornerLaneOffsets(
      bus,
      acceptedPlans.filter((plan) => plan.targetLayer === targetLayer),
    ).exit
    if (layerLocalExitOffset !== cornerLaneOffsets.exit) {
      // Preserve successful shared-band routes first. If those patterns
      // fail, reuse the corner slots occupied only on other copper layers.
      terminalPatterns.push(
        ...terminalPatterns.map((pattern) => ({
          ...pattern,
          label: `${pattern.label}-layer-local-corner`,
          cornerExitLaneOffset: layerLocalExitOffset,
        })),
      )
    }
  }
  return terminalPatterns
}
