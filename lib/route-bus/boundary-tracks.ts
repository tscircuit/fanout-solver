import { getDirectionForExitEdge } from "../boundary-exit"
import type {
  FanoutDirection,
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "../types"
import { getConnectionRank } from "./connection-order"
import {
  busUsesCoordinatedWindingChannel,
  directionSign,
  getCornerSide,
  getPerpendicularAxis,
  isHorizontal,
} from "./directions"
import { getPointLayer, getWindingTargetRank } from "./winding-target-orders"

export function getDistributedBoundaryTargetTracks(params: {
  bus: PreparedBus
  boundaryDirection: FanoutDirection
  traceWidth: number
  clearance: number
  allowLayerInterleaving?: boolean
}): number[] | undefined {
  const { bus, boundaryDirection, traceWidth, clearance } = params
  if (getCornerSide(bus) || !busUsesCoordinatedWindingChannel(bus))
    return undefined
  const layers = new Set(
    bus.connections.map(
      (connection) =>
        connection.exitTargetPoint?.layer ??
        getPointLayer(connection.targetPoint),
    ),
  )
  const minimum = isHorizontal(boundaryDirection)
    ? bus.sharedBoundary.minY
    : bus.sharedBoundary.minX
  const maximum = isHorizontal(boundaryDirection)
    ? bus.sharedBoundary.maxY
    : bus.sharedBoundary.maxX
  const tracks = bus.connections
    .map((connection) =>
      Math.max(
        minimum,
        Math.min(
          maximum,
          getPerpendicularAxis(
            connection.exitTargetPoint ?? connection.targetPoint,
            boundaryDirection,
          ),
        ),
      ),
    )
    .toSorted((a, b) => a - b)
  const pitch = traceWidth + clearance
  if (
    (layers.size < 2 || !params.allowLayerInterleaving) &&
    tracks.every(
      (track, index) =>
        index === 0 || track - tracks[index - 1]! >= pitch - 1e-9,
    )
  )
    return undefined
  if (maximum - minimum < (tracks.length - 1) * pitch - 1e-9) return undefined
  // Pool neighboring overlaps while preserving their mean requested location.
  // Subtracting the pitch reduces the clearance constraint to monotonicity.
  const blocks: { start: number; count: number; mean: number }[] = []
  for (const [index, track] of tracks.entries()) {
    blocks.push({ start: index, count: 1, mean: track - index * pitch })
    while (blocks.length > 1 && blocks.at(-2)!.mean > blocks.at(-1)!.mean) {
      const second = blocks.pop()!
      const first = blocks.pop()!
      blocks.push({
        start: first.start,
        count: first.count + second.count,
        mean:
          (first.mean * first.count + second.mean * second.count) /
          (first.count + second.count),
      })
    }
  }
  for (const block of blocks) {
    const mean = Math.max(
      minimum,
      Math.min(maximum - (tracks.length - 1) * pitch, block.mean),
    )
    for (let index = block.start; index < block.start + block.count; index++)
      tracks[index] = mean + index * pitch
  }
  return tracks
}

export function getBoundaryTargetTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  boundaryDirection: FanoutDirection
  traceWidth?: number
  clearance?: number
  layerNames?: readonly string[]
  targetLayer?: string
  windingOrderIndex?: number
  allowLayerInterleaving?: boolean
  fixedBoundaryTracksByConnectionIndex?: ReadonlyMap<number, number>
}): number {
  const fixedTrack = params.fixedBoundaryTracksByConnectionIndex?.get(
    params.connection.connectionIndex,
  )
  if (fixedTrack !== undefined) return fixedTrack

  const requestedTrack = getPerpendicularAxis(
    params.connection.exitTargetPoint ?? params.connection.targetPoint,
    params.boundaryDirection,
  )
  const boundaryMinimum = isHorizontal(params.boundaryDirection)
    ? params.bus.sharedBoundary.minY
    : params.bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(params.boundaryDirection)
    ? params.bus.sharedBoundary.maxY
    : params.bus.sharedBoundary.maxX
  const distributedTracks =
    params.traceWidth !== undefined && params.clearance !== undefined
      ? getDistributedBoundaryTargetTracks({
          ...params,
          traceWidth: params.traceWidth,
          clearance: params.clearance,
        })
      : undefined
  if (distributedTracks && params.layerNames && params.targetLayer) {
    const { rank } = getWindingTargetRank({
      ...params,
      layerNames: params.layerNames,
      targetLayer: params.targetLayer,
    })
    return distributedTracks[rank]!
  }
  return Math.max(boundaryMinimum, Math.min(boundaryMaximum, requestedTrack))
}

export function getCornerTargetTrack(params: {
  bus: PreparedBus
  connection: PreparedConnection
  cornerExitLaneOffset: number
  traceWidth: number
  viaDiameter: number
  clearance: number
  layerNames: readonly string[]
  targetLayer: string
  windingOrderIndex?: number
  cornerBandTargetTrackOffset?: number
  fixedBoundaryTracksByConnectionIndex?: ReadonlyMap<number, number>
}): number {
  const fixedTrack = params.fixedBoundaryTracksByConnectionIndex?.get(
    params.connection.connectionIndex,
  )
  if (fixedTrack !== undefined) return fixedTrack

  const {
    bus,
    connection,
    cornerExitLaneOffset,
    traceWidth,
    viaDiameter,
    clearance,
    layerNames,
    targetLayer,
    windingOrderIndex,
    cornerBandTargetTrackOffset = 0,
  } = params
  const side = getCornerSide(bus)
  if (!side || !bus.exitEdge) {
    return getPerpendicularAxis(
      connection.exitTargetPoint ?? connection.targetPoint,
      bus.direction,
    )
  }
  const boundaryDirection = getDirectionForExitEdge(bus.exitEdge)
  const boundaryMinimum = isHorizontal(boundaryDirection)
    ? bus.sharedBoundary.minY
    : bus.sharedBoundary.minX
  const boundaryMaximum = isHorizontal(boundaryDirection)
    ? bus.sharedBoundary.maxY
    : bus.sharedBoundary.maxX
  const pitch = Math.max(traceWidth + clearance, viaDiameter + clearance)
  const baseBandCenter =
    boundaryMinimum +
    (boundaryMaximum - boundaryMinimum) * (side === "minimum" ? 0.25 : 0.75) +
    cornerBandTargetTrackOffset
  const windingTarget = busUsesCoordinatedWindingChannel(bus)
    ? getWindingTargetRank({
        bus,
        connection,
        boundaryDirection,
        layerNames,
        targetLayer,
        windingOrderIndex,
      })
    : undefined
  const bandConnectionCount = Math.max(
    bus.connections.length,
    bus.cornerBandConnectionCount ?? bus.connections.length,
    cornerExitLaneOffset + (windingTarget?.connectionCount ?? 0),
  )
  const firstTrack = baseBandCenter - ((bandConnectionCount - 1) * pitch) / 2
  const rank = windingTarget?.rank ?? getConnectionRank(bus, connection)
  const globalSlot = cornerExitLaneOffset + rank
  const reverseSlotOrder =
    !windingTarget &&
    (side === "maximum") === directionSign(boundaryDirection) > 0
  const orientedSlot = reverseSlotOrder
    ? bandConnectionCount - 1 - globalSlot
    : globalSlot
  return firstTrack + orientedSlot * pitch
}

export function getCornerLaneOffsets(
  bus: PreparedBus,
  acceptedPlans: readonly FanoutRoutePlan[],
): { exit: number; localChannel: number; boundaryChannel: number } {
  const side = getCornerSide(bus)
  if (!side || !bus.exitEdge) {
    return { exit: 0, localChannel: 0, boundaryChannel: 0 }
  }
  const cornerPlans = acceptedPlans.filter(
    (plan) => plan.exitEdge && plan.cornerBandSide !== undefined,
  )
  const plansOnExitEdge = cornerPlans.filter(
    (plan) => plan.exitEdge === bus.exitEdge && plan.cornerBandSide === side,
  )
  const plansOnLocalEdge = cornerPlans.filter(
    (plan) => plan.direction === bus.direction,
  )
  return {
    exit: plansOnExitEdge.length,
    localChannel: plansOnLocalEdge.length,
    boundaryChannel: plansOnExitEdge.length,
  }
}
