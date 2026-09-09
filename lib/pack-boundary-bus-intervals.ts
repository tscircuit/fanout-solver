import { getBoundaryTargetTrack, getCornerTargetTrack } from "./route-bus"
import { getBoundaryBusSlotOffsets } from "./get-boundary-bus-slot-offsets"
import { getCornerBandSide, getDirectionForExitEdge } from "./boundary-exit"
import type { FanoutEdge, PreparedBus } from "./types"

export interface PackedBoundaryBusInterval {
  busId: string
  layer: string
  edge: FanoutEdge
  minimum: number
  maximum: number
  connectionIndices: number[]
  desiredTracks: number[]
  tracks: number[]
  desiredStart: number
  desiredEnd: number
  start: number
  end: number
  shift: number
}

/** Translate whole bus intervals while preserving each lane's identity,
 * order, spacing, assigned layer, and original shared-boundary edge. Minimize
 * squared movement of individual connection targets with weighted isotonic PAV.
 */
export function packBoundaryBusIntervals(params: {
  buses: readonly PreparedBus[]
  targetLayerByBusId: ReadonlyMap<string, string>
  layerNames: readonly string[]
  traceWidth: number
  viaDiameter: number
  clearance: number
}): {
  tracksByConnectionIndex: Map<number, number>
  intervals: PackedBoundaryBusInterval[]
} {
  const { buses, targetLayerByBusId, traceWidth, clearance } = params
  const pitch = traceWidth + clearance
  if (
    !(traceWidth > 0) ||
    !(params.viaDiameter > 0) ||
    clearance < 0 ||
    ![traceWidth, params.viaDiameter, clearance].every(Number.isFinite)
  )
    throw new Error("FanoutSolver: invalid boundary packing dimensions")
  const slots = getBoundaryBusSlotOffsets(buses)
  const intervals: PackedBoundaryBusInterval[] = []
  const groups = new Map<string, PackedBoundaryBusInterval[]>()
  for (const bus of buses) {
    if (bus.termination.type !== "boundary") continue
    if (bus.connections.length === 0)
      throw new Error(`FanoutSolver: bus ${bus.busId} has no connections`)
    if (!bus.exitEdge)
      throw new Error(`FanoutSolver: bus ${bus.busId} has no boundary edge`)
    const layer = targetLayerByBusId.get(bus.busId)
    if (
      !layer ||
      !params.layerNames.includes(layer) ||
      !(
        bus.routableEscapeLayers ??
        bus.allowedLayers ??
        params.layerNames
      ).includes(layer)
    )
      throw new Error(
        `FanoutSolver: bus ${bus.busId} has no legal assigned layer`,
      )
    const direction = getDirectionForExitEdge(bus.exitEdge)
    const corner = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    const desiredTracks = bus.connections.map((connection) =>
      corner
        ? getCornerTargetTrack({
            ...params,
            bus,
            connection,
            targetLayer: layer,
            cornerExitLaneOffset: slots.get(bus.busId) ?? 0,
            windingOrderIndex: 0,
          })
        : getBoundaryTargetTrack({
            ...params,
            bus,
            connection,
            targetLayer: layer,
            boundaryDirection: direction,
            windingOrderIndex: 0,
          }),
    )
    const sortedTracks = desiredTracks.toSorted((a, b) => a - b)
    if (
      sortedTracks.some(
        (track, index) =>
          !Number.isFinite(track) ||
          (index > 0 && track - sortedTracks[index - 1]! < pitch - 1e-8),
      )
    )
      throw new Error(
        `FanoutSolver: bus ${bus.busId} already contains overlapping desired lanes`,
      )
    const vertical = bus.exitEdge === "left" || bus.exitEdge === "right"
    const interval: PackedBoundaryBusInterval = {
      busId: bus.busId,
      layer,
      edge: bus.exitEdge,
      minimum: vertical ? bus.sharedBoundary.minY : bus.sharedBoundary.minX,
      maximum: vertical ? bus.sharedBoundary.maxY : bus.sharedBoundary.maxX,
      connectionIndices: bus.connections.map((c) => c.connectionIndex),
      desiredTracks,
      tracks: [...desiredTracks],
      desiredStart: sortedTracks[0]!,
      desiredEnd: sortedTracks.at(-1)!,
      start: sortedTracks[0]!,
      end: sortedTracks.at(-1)!,
      shift: 0,
    }
    if (
      ![interval.minimum, interval.maximum].every(Number.isFinite) ||
      interval.maximum < interval.minimum
    )
      throw new Error(`FanoutSolver: invalid boundary for ${bus.busId}`)
    intervals.push(interval)
    const key = `${layer}:${bus.exitEdge}`
    const group = groups.get(key) ?? []
    group.push(interval)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    // Quantize insignificant arithmetic noise so equal requested centers retain
    // the original bus order. Quantization keeps the sort relation transitive.
    const center = (interval: PackedBoundaryBusInterval) =>
      Number(((interval.desiredStart + interval.desiredEnd) / 2).toFixed(9))
    const ordered = group.toSorted((a, b) => center(a) - center(b))
    const minimum = Math.max(...ordered.map((i) => i.minimum))
    const maximum = Math.min(...ordered.map((i) => i.maximum))
    // Avoid even floating-point translations when the requested intervals
    // already fit. Existing separated layouts must remain bit-for-bit stable.
    if (
      ordered.every(
        (interval, index) =>
          interval.desiredStart >= minimum &&
          interval.desiredEnd <= maximum &&
          (index === 0 ||
            interval.desiredStart - ordered[index - 1]!.desiredEnd >=
              pitch - 1e-8),
      )
    )
      continue
    const offsets: number[] = []
    let occupiedWidth = 0
    for (const [index, interval] of ordered.entries()) {
      offsets.push(occupiedWidth)
      occupiedWidth +=
        interval.desiredEnd -
        interval.desiredStart +
        (index < ordered.length - 1 ? pitch : 0)
    }
    if (occupiedWidth > maximum - minimum + 1e-8)
      throw new Error(
        `FanoutSolver: bus intervals do not fit ${ordered[0]!.layer}/${ordered[0]!.edge}`,
      )
    const blocks: Array<{
      first: number
      last: number
      weight: number
      mean: number
    }> = []
    for (const [index, interval] of ordered.entries()) {
      blocks.push({
        first: index,
        last: index,
        weight: interval.connectionIndices.length,
        mean: interval.desiredStart - offsets[index]!,
      })
      while (blocks.length > 1 && blocks.at(-2)!.mean > blocks.at(-1)!.mean) {
        const second = blocks.pop()!,
          first = blocks.pop()!,
          weight = first.weight + second.weight
        blocks.push({
          first: first.first,
          last: second.last,
          weight,
          mean:
            (first.mean * first.weight + second.mean * second.weight) / weight,
        })
      }
    }
    const upper = maximum - occupiedWidth
    for (const block of blocks) {
      const mean = Math.max(minimum, Math.min(upper, block.mean))
      for (let index = block.first; index <= block.last; index++) {
        const interval = ordered[index]!
        interval.start = mean + offsets[index]!
        interval.shift = interval.start - interval.desiredStart
        interval.end = interval.desiredEnd + interval.shift
        interval.tracks = interval.desiredTracks.map(
          (track) => track + interval.shift,
        )
      }
    }
  }
  return {
    tracksByConnectionIndex: new Map(
      intervals.flatMap((interval) =>
        interval.connectionIndices.map(
          (index, lane) => [index, interval.tracks[lane]!] as const,
        ),
      ),
    ),
    intervals,
  }
}
