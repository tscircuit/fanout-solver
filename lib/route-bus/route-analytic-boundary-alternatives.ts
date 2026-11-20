import type { FanoutRoutePlan, PreparedConnection } from "../types"
import { addAlternative } from "./boundary-routing-context"
import { buildPlan } from "./build-plan"
import { getConnectionOrders, getConnectionRank } from "./connection-order"
import { planIsClear } from "./plan-clearance"
import {
  getLegacyPreferredTrack,
  getPreferredTrack,
  getTrackCandidates,
} from "./track-candidates"
import type { RouteBusBoundaryContext, ViaHandedness } from "./types"

export function routeAnalyticBoundaryAlternatives(
  context: RouteBusBoundaryContext,
  startAtSource = false,
): void {
  const {
    bus,
    fixedViaPointsByConnectionIndex,
    reservedVias,
    viaMinimalOnly,
    viaHandednesses,
    alternatives,
    maxAlternatives,
  } = context
  // The analytic fallback chooses its own dogbone and checks accepted copper
  // only. It cannot replace an explicit source prefix or occupy a future hard
  // reservation after the reservation-aware winding alternatives have failed.
  if (
    viaMinimalOnly ||
    fixedViaPointsByConnectionIndex ||
    context.sourceEscapePaths ||
    reservedVias.length > 0
  )
    return

  for (const viaHandedness of viaHandednesses) {
    for (const connectionOrder of getConnectionOrders(bus)) {
      searchConnectionOrder(
        {
          connectionOrder,
          viaHandedness,
          connectionIndex: 0,
          candidatePlans: [],
          startAtSource,
        },
        context,
      )
      if (alternatives.length >= maxAlternatives) return
    }
  }
  if (
    !startAtSource &&
    alternatives.length === 0 &&
    bus.connections.every(
      (connection) => connection.sourceLayer === context.targetLayer,
    )
  ) {
    routeAnalyticBoundaryAlternatives(context, true)
  }
}

export function searchConnectionOrder(
  {
    connectionOrder,
    viaHandedness,
    connectionIndex,
    candidatePlans,
    startAtSource,
  }: {
    connectionOrder: PreparedConnection[]
    viaHandedness: ViaHandedness
    connectionIndex: number
    candidatePlans: FanoutRoutePlan[]
    startAtSource: boolean
  },
  context: RouteBusBoundaryContext,
): void {
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
    compactBusTracks,
    staticClearanceCache,
    blockingBusCounts,
    allowBlindAndBuriedVias,
    allowSameNetMerges,
    fixedBoundaryTracksByConnectionIndex,
    cornerBandTargetTrackOffset,
    exitAxis,
    targetUsesVia,
    interstitialEscape,
    cornerLaneOffsets,
    alternatives,
    maxAlternatives,
  } = context

  if (alternatives.length >= maxAlternatives) return
  if (connectionIndex >= connectionOrder.length) {
    addAlternative(candidatePlans, context)
    return
  }

  const preparedConnection = connectionOrder[connectionIndex]!
  const connectionRank = getConnectionRank(bus, preparedConnection)
  const preferredTracks = [
    getPreferredTrack({
      bus,
      connection: preparedConnection,
      traceWidth,
    }),
    getLegacyPreferredTrack({
      bus,
      connection: preparedConnection,
      targetUsesVia,
      interstitialEscape,
      compactBusTracks,
      traceWidth,
      viaDiameter,
      clearance,
    }),
  ].filter(
    (track, index, tracks) =>
      tracks.findIndex((candidate) => Math.abs(candidate - track) < 1e-9) ===
      index,
  )
  const trackCandidates = preferredTracks
    .flatMap((preferredTrack) =>
      getTrackCandidates({
        bus,
        connection: preparedConnection,
        preferredTrack,
        traceWidth,
        clearance,
        includeMidpointTracks: startAtSource,
      }),
    )
    .filter(
      (track, index, tracks) =>
        tracks.findIndex(
          (candidate) => Math.abs(candidate.value - track.value) < 1e-9,
        ) === index,
    )
  for (let trackIndex = 0; trackIndex < trackCandidates.length; trackIndex++) {
    const track = trackCandidates[trackIndex]!
    const plan = buildPlan({
      preparedConnection,
      bus,
      targetLayer,
      track: track.value,
      exitAxis,
      layerNames,
      traceWidth,
      viaDiameter,
      viaHoleDiameter,
      viaHandedness,
      interstitialEscape,
      spreadLaneIndex: Math.min(
        connectionRank,
        bus.connections.length - connectionRank - 1,
      ),
      cornerExitLaneOffset: cornerLaneOffsets.exit,
      cornerLocalChannelLaneOffset: cornerLaneOffsets.localChannel,
      cornerBoundaryChannelLaneOffset: cornerLaneOffsets.boundaryChannel,
      clearance,
      terminateAtVia: false,
      allowBlindAndBuriedVias,
      cornerBandTargetTrackOffset,
      fixedBoundaryTracksByConnectionIndex,
      initialViaPoint: startAtSource ? preparedConnection.sourcePoint : undefined,
    })
    if (
      !planIsClear({
        plan,
        otherPlans: [...acceptedPlans, ...candidatePlans],
        staticClearanceCache,
        blockingBusCounts,
        cacheKey: `boundary:${bus.busId}:${bus.direction}:${targetLayer}:${preparedConnection.connectionIndex}:${viaHandedness}:${trackIndex}:${bus.exitEdge ?? "legacy"}:${cornerLaneOffsets.exit}:${cornerLaneOffsets.localChannel}:${cornerLaneOffsets.boundaryChannel}:${cornerBandTargetTrackOffset ?? 0}:${fixedBoundaryTracksByConnectionIndex?.get(preparedConnection.connectionIndex) ?? "default"}${startAtSource ? ":source-origin" : ""}`,
        srj,
        sharedBoundary: bus.sharedBoundary,
        clearance,
        allowBlindAndBuriedVias,
        allowSameNetMerges,
      })
    ) {
      continue
    }
    searchConnectionOrder(
      {
        connectionOrder,
        viaHandedness,
        connectionIndex: connectionIndex + 1,
        candidatePlans: [...candidatePlans, plan],
        startAtSource,
      },
      context,
    )
    if (alternatives.length >= maxAlternatives) return
    if (maxAlternatives === 1) return
  }
}
