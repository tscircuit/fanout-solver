import { getCornerBandSide } from "./boundary-exit"
import type { PreparedBus } from "./types"

/** Reserve intact bus intervals before choosing which bus to route first. */
export function getBoundaryBusSlotOffsets(
  buses: readonly PreparedBus[],
): Map<string, number> {
  const groups = new Map<string, PreparedBus[]>()
  for (const bus of buses) {
    const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
    if (bus.termination.type !== "boundary" || !bus.exitEdge || !side) continue
    const key = `${bus.exitEdge}:${side}`
    const group = groups.get(key) ?? []
    group.push(bus)
    groups.set(key, group)
  }
  const result = new Map<string, number>()
  for (const group of groups.values()) {
    const axis =
      group[0]!.exitEdge === "left" || group[0]!.exitEdge === "right"
        ? "y"
        : "x"
    const intervals = group
      .map((bus, index) => ({
        bus,
        index,
        min: Math.min(...bus.connections.map((c) => c.sourcePoint[axis])),
        max: Math.max(...bus.connections.map((c) => c.sourcePoint[axis])),
      }))
      .sort((a, b) => a.min - b.min || a.index - b.index)
    const fields: Array<{ max: number; members: typeof intervals }> = []
    for (const interval of intervals) {
      const field = fields.at(-1)
      if (!field || interval.min > field.max + 1e-9) {
        fields.push({ max: interval.max, members: [interval] })
      } else {
        field.max = Math.max(field.max, interval.max)
        field.members.push(interval)
      }
    }
    let offset = 0
    for (const field of fields) {
      // Overlapping source fields retain input bus order. Disjoint fields
      // retain their increasing boundary-tangent order on every exit edge.
      for (const { bus } of field.members.sort((a, b) => a.index - b.index)) {
        result.set(bus.busId, offset)
        offset += bus.connections.length
      }
    }
  }
  return result
}
