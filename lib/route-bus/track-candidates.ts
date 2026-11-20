import type { PreparedBus, PreparedConnection } from "../types"
import { getConnectionRank, getDepthInRows } from "./connection-order"
import {
  busUsesCoordinatedWindingChannel,
  getCornerSide,
  getPerpendicularAxis,
  isHorizontal,
} from "./directions"

export interface TrackCandidate {
  value: number
  kind: "corridor" | "gap" | "margin" | "preferred"
}

export function getTracksInSpan(
  minimum: number,
  maximum: number,
  traceWidth: number,
  clearance: number,
  kind: TrackCandidate["kind"],
): TrackCandidate[] {
  const freeWidth = maximum - minimum
  const trackCount = Math.floor(
    (freeWidth - clearance) / (traceWidth + clearance) + 1e-9,
  )
  if (trackCount < 1) return []
  const usedWidth = trackCount * traceWidth + (trackCount - 1) * clearance
  const firstTrack = minimum + (freeWidth - usedWidth) / 2 + traceWidth / 2
  return Array.from({ length: trackCount }, (_, index) => ({
    value: firstTrack + index * (traceWidth + clearance),
    kind,
  }))
}

export function getTrackCandidates(params: {
  bus: PreparedBus
  connection: PreparedConnection
  preferredTrack: number
  traceWidth: number
  clearance: number
}): TrackCandidate[] {
  const { bus, connection, preferredTrack, traceWidth, clearance } = params
  const coordinates = (
    isHorizontal(bus.direction) ? bus.yCoordinates : bus.xCoordinates
  ).toSorted((a, b) => a - b)
  const obstacleHalfSize = Math.max(
    ...bus.componentObstacles.map((obstacle) =>
      isHorizontal(bus.direction) ? obstacle.height / 2 : obstacle.width / 2,
    ),
  )
  const boundaryMinimum = isHorizontal(bus.direction)
    ? bus.sharedBoundary.minY
    : bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(bus.direction)
    ? bus.sharedBoundary.maxY
    : bus.sharedBoundary.maxX
  const maximumJog = boundaryMaximum - boundaryMinimum
  const ladderMinimum = boundaryMinimum
  const ladderMaximum = boundaryMaximum
  const tracks: TrackCandidate[] = [
    { value: preferredTrack, kind: "preferred" },
    ...getTracksInSpan(
      ladderMinimum,
      coordinates[0]! - obstacleHalfSize,
      traceWidth,
      clearance,
      "margin",
    ),
  ]
  for (let index = 0; index < coordinates.length; index++) {
    tracks.push({ value: coordinates[index]!, kind: "corridor" })
    if (index < coordinates.length - 1) {
      // Mixed pad sizes can leave gaps hidden by the largest component pad.
      tracks.push({
        value: (coordinates[index]! + coordinates[index + 1]!) / 2,
        kind: "gap",
      })
      tracks.push(
        ...getTracksInSpan(
          coordinates[index]! + obstacleHalfSize,
          coordinates[index + 1]! - obstacleHalfSize,
          traceWidth,
          clearance,
          "gap",
        ),
      )
    }
  }
  tracks.push(
    ...getTracksInSpan(
      coordinates.at(-1)! + obstacleHalfSize,
      ladderMaximum,
      traceWidth,
      clearance,
      "margin",
    ),
  )

  const sourceTrack = getPerpendicularAxis(
    connection.sourcePoint,
    bus.direction,
  )
  const componentCenter = (coordinates[0]! + coordinates.at(-1)!) / 2
  return tracks
    .filter((track) => Math.abs(track.value - sourceTrack) <= maximumJog + 1e-9)
    .filter(
      (track, index, candidates) =>
        candidates.findIndex(
          (candidate) => Math.abs(candidate.value - track.value) < 1e-9,
        ) === index,
    )
    .sort(
      (a, b) =>
        Math.abs(a.value - preferredTrack) -
        Math.abs(b.value - preferredTrack) -
        (Math.abs(a.value - componentCenter) -
          Math.abs(b.value - componentCenter)) *
          1e-3,
    )
}

export function getPreferredTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  traceWidth: number
}): number {
  const preferredTrack =
    getCornerSide(params.bus) || busUsesCoordinatedWindingChannel(params.bus)
      ? getPerpendicularAxis(
          params.connection.sourcePoint,
          params.bus.direction,
        )
      : getPerpendicularAxis(
          params.connection.exitTargetPoint ?? params.connection.targetPoint,
          params.bus.direction,
        )
  const boundaryMinimum = isHorizontal(params.bus.direction)
    ? params.bus.sharedBoundary.minY
    : params.bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(params.bus.direction)
    ? params.bus.sharedBoundary.maxY
    : params.bus.sharedBoundary.maxX

  return Math.max(
    boundaryMinimum + params.traceWidth / 2,
    Math.min(boundaryMaximum - params.traceWidth / 2, preferredTrack),
  )
}

export function getLegacyPreferredTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  targetUsesVia: boolean
  interstitialEscape: boolean
  compactBusTracks: boolean
  traceWidth: number
  viaDiameter: number
  clearance: number
}): number {
  const {
    bus,
    connection,
    targetUsesVia,
    interstitialEscape,
    compactBusTracks,
    traceWidth,
    viaDiameter,
    clearance,
  } = params
  const perpendicularCoordinates = (
    isHorizontal(bus.direction) ? bus.yCoordinates : bus.xCoordinates
  ).toSorted((a, b) => a - b)
  const sourceTrack = getPerpendicularAxis(
    connection.sourcePoint,
    bus.direction,
  )
  if (compactBusTracks) {
    const connectionRank = getConnectionRank(bus, connection)
    const componentCenter =
      (perpendicularCoordinates[0]! + perpendicularCoordinates.at(-1)!) / 2
    return (
      componentCenter +
      (connectionRank - (bus.connections.length - 1) / 2) *
        (traceWidth + clearance)
    )
  }
  if (!targetUsesVia || !interstitialEscape) return sourceTrack

  const depthInRows = getDepthInRows(bus)
  const trackPitch = traceWidth + clearance
  const halfConnectionCount = Math.ceil(bus.connections.length / 2)
  const sideBandWidth = (halfConnectionCount - 1) * trackPitch
  const bandSeparation = viaDiameter / 2 + traceWidth / 2 + clearance + 1e-3
  const depthIndex = Math.round(depthInRows) + 1
  const nearOffset =
    depthIndex * bandSeparation + (depthIndex - 1) * sideBandWidth
  const connectionRank = getConnectionRank(bus, connection)
  const componentMinimum = perpendicularCoordinates[0]!
  const componentMaximum = perpendicularCoordinates.at(-1)!
  const requestedTrack =
    connectionRank < halfConnectionCount
      ? componentMinimum -
        nearOffset -
        (halfConnectionCount - connectionRank - 1) * trackPitch
      : componentMaximum +
        nearOffset +
        (connectionRank - halfConnectionCount) * trackPitch
  const boundaryMinimum = isHorizontal(bus.direction)
    ? bus.sharedBoundary.minY
    : bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(bus.direction)
    ? bus.sharedBoundary.maxY
    : bus.sharedBoundary.maxX

  return Math.max(
    boundaryMinimum + traceWidth / 2,
    Math.min(boundaryMaximum - traceWidth / 2, requestedTrack),
  )
}
