import type { FanoutRoutePlan, PreparedConnection } from "../types"
import { addAlternative } from "./boundary-routing-context"
import { buildPlan } from "./build-plan"
import { getConnectionOrders, getConnectionRank } from "./connection-order"
import {
  busUsesCoordinatedWindingChannel,
  getCornerSide,
  getLocalCornerSide,
  getPerpendicularAxis,
} from "./directions"
import { planIsClear } from "./plan-clearance"
import {
  getLegacyPreferredTrack,
  getPreferredTrack,
  getTrackCandidates,
} from "./track-candidates"
import type { RouteBusBoundaryContext, ViaHandedness } from "./types"

const searchConnectionOrders = (
  context: RouteBusBoundaryContext,
  {
    startAtSource = false,
    preferSourceTracks = false,
  }: { startAtSource?: boolean; preferSourceTracks?: boolean } = {},
): void => {
  for (const viaHandedness of context.viaHandednesses) {
    for (const connectionOrder of getConnectionOrders(context.bus)) {
      searchConnectionOrder(
        {
          connectionOrder,
          viaHandedness,
          connectionIndex: 0,
          candidatePlans: [],
          startAtSource,
          preferSourceTracks,
        },
        context,
      )
      if (context.alternatives.length >= context.maxAlternatives) return
    }
  }
}

export function routeAnalyticBoundaryAlternatives(
  context: RouteBusBoundaryContext,
): void {
  // The analytic fallback cannot replace an explicit source prefix or occupy
  // a future hard reservation after reservation-aware winding has failed.
  if (
    context.viaMinimalOnly ||
    context.fixedViaPointsByConnectionIndex ||
    context.sourceEscapePaths ||
    context.reservedVias.length > 0
  )
    return

  searchConnectionOrders(context)
  const sourceTrackIsGuided =
    Boolean(getCornerSide(context.bus) || getLocalCornerSide(context.bus)) ||
    busUsesCoordinatedWindingChannel(context.bus)
  // Target-aligned boundary tracks send every member of a pad column through
  // the same channel beside that column. When the downstream order differs
  // from the source order those runs cannot coexist. The members can still
  // leave side by side on the tracks nearest their own pads, so offer that
  // source-aligned breakout before giving the bus up on this layer.
  if (
    context.alternatives.length === 0 &&
    context.bus.connections.length > 1 &&
    !sourceTrackIsGuided &&
    !context.fixedBoundaryTracksByConnectionIndex
  )
    searchConnectionOrders(context, { preferSourceTracks: true })
  if (
    context.alternatives.length > 0 ||
    context.targetUsesVia ||
    sourceTrackIsGuided
  )
    return

  // A same-layer trace can turn at the pad when the ordinary escape is blocked.
  searchConnectionOrders(context, { startAtSource: true })
}

export function searchConnectionOrder(
  {
    connectionOrder,
    viaHandedness,
    connectionIndex,
    candidatePlans,
    startAtSource = false,
    preferSourceTracks = false,
  }: {
    connectionOrder: PreparedConnection[]
    viaHandedness: ViaHandedness
    connectionIndex: number
    candidatePlans: FanoutRoutePlan[]
    startAtSource?: boolean
    preferSourceTracks?: boolean
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
  const sourceTrack = getPerpendicularAxis(
    preparedConnection.sourcePoint,
    bus.direction,
  )
  // The straightest source-aligned breakout continues from the escape via.
  // That keeps the tracks through the pad rows open for deeper columns.
  const sourceAlignedTracks: number[] = []
  if (preferSourceTracks) {
    const probe = buildPlan({
      preparedConnection,
      bus,
      targetLayer,
      track: sourceTrack,
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
    })
    if (probe.via)
      sourceAlignedTracks.push(
        getPerpendicularAxis(probe.via.center, bus.direction),
      )
    sourceAlignedTracks.push(sourceTrack)
  }
  const preferredTracks = [
    ...sourceAlignedTracks,
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
        includePadGapMidpoints: startAtSource,
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
    const cacheKey = `boundary:${startAtSource}:${preferSourceTracks}:${bus.busId}:${bus.direction}:${targetLayer}:${preparedConnection.connectionIndex}:${viaHandedness}:${trackIndex}:${bus.exitEdge ?? "legacy"}:${cornerLaneOffsets.exit}:${cornerLaneOffsets.localChannel}:${cornerLaneOffsets.boundaryChannel}:${cornerBandTargetTrackOffset ?? 0}:${fixedBoundaryTracksByConnectionIndex?.get(preparedConnection.connectionIndex) ?? "default"}`
    if (staticClearanceCache?.get(cacheKey) === false) continue
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
      initialViaPoint: startAtSource
        ? preparedConnection.sourcePoint
        : undefined,
      cornerBandTargetTrackOffset,
      fixedBoundaryTracksByConnectionIndex,
    })
    if (
      !planIsClear({
        plan,
        otherPlans: [...acceptedPlans, ...candidatePlans],
        staticClearanceCache,
        blockingBusCounts,
        cacheKey,
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
        preferSourceTracks,
      },
      context,
    )
    if (alternatives.length >= maxAlternatives) return
    if (maxAlternatives === 1) return
  }
}
