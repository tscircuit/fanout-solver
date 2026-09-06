import { getCornerBandSide } from "./boundary-exit"
import type { RouteBusParams } from "./route-bus"

/** Midpoints of unoccupied edge intervals, clipped to the bus's declared band. */
export function getFreeBoundaryTracks(
  params: Pick<
    RouteBusParams,
    | "bus"
    | "targetLayer"
    | "acceptedPlans"
    | "reservedVias"
    | "traceWidth"
    | "clearance"
  >,
): number[] {
  const { bus, targetLayer, traceWidth, clearance } = params
  if (!bus.exitEdge) return []
  const vertical = bus.exitEdge === "left" || bus.exitEdge === "right"
  const along = vertical ? "y" : "x"
  const across = vertical ? "x" : "y"
  const boundary = bus.sharedBoundary
  const edge =
    bus.exitEdge === "left"
      ? boundary.minX
      : bus.exitEdge === "right"
        ? boundary.maxX
        : bus.exitEdge === "bottom"
          ? boundary.minY
          : boundary.maxY
  const lower = vertical ? boundary.minY : boundary.minX
  const upper = vertical ? boundary.maxY : boundary.maxX
  const middle = (lower + upper) / 2
  const side = getCornerBandSide(bus.exitEdge, bus.preferredExit)
  const minimum = (side === "maximum" ? middle : lower) + traceWidth / 2
  const maximum = (side === "minimum" ? middle : upper) - traceWidth / 2
  const blocked: [number, number][] = []
  for (const plan of params.acceptedPlans) {
    for (const segment of [
      ...plan.segments,
      ...(plan.planeEndpointSegments ?? []),
    ]) {
      if (segment.layer !== targetLayer) continue
      const radius = (segment.width + traceWidth) / 2 + clearance
      const start = segment.start[across]
      const delta = segment.end[across] - start
      let from = 0
      let to = 1
      if (Math.abs(delta) < 1e-9) {
        if (Math.abs(start - edge) > radius) continue
      } else {
        const first = (edge - radius - start) / delta
        const last = (edge + radius - start) / delta
        from = Math.max(0, Math.min(first, last))
        to = Math.min(1, Math.max(first, last))
        if (from > to) continue
      }
      const alongStart = segment.start[along]
      const alongDelta = segment.end[along] - alongStart
      const first = alongStart + from * alongDelta
      const last = alongStart + to * alongDelta
      blocked.push([
        Math.min(first, last) - radius,
        Math.max(first, last) + radius,
      ])
    }
  }
  const vias = [
    ...params.acceptedPlans.flatMap((plan) => [
      ...(plan.via ? [plan.via] : []),
      ...(plan.additionalVias ?? []),
      ...(plan.planeEndpointVia ? [plan.planeEndpointVia] : []),
    ]),
    ...(params.reservedVias ?? []).map((reserved) => reserved.via),
  ]
  for (const via of vias) {
    if (!via.spanLayers.includes(targetLayer)) continue
    const radius = via.diameter / 2 + traceWidth / 2 + clearance
    const distance = Math.abs(via.center[across] - edge)
    if (distance >= radius) continue
    const extent = Math.sqrt(radius * radius - distance * distance)
    blocked.push([via.center[along] - extent, via.center[along] + extent])
  }
  const gaps: [number, number][] = []
  let cursor = minimum
  for (const [from, to] of blocked.sort((a, b) => a[0] - b[0])) {
    if (to <= cursor || from >= maximum) continue
    if (from > cursor) gaps.push([cursor, Math.min(from, maximum)])
    cursor = Math.max(cursor, to)
    if (cursor >= maximum) break
  }
  if (cursor < maximum) gaps.push([cursor, maximum])
  // Edge order gives deterministic, symmetric coverage without hard-coded tracks.
  const tracks = gaps
    .filter(([from, to]) => to - from > 1e-6)
    .map(([from, to]) => (from + to) / 2)
  return tracks.length <= 32
    ? tracks
    : Array.from(
        { length: 32 },
        (_, index) => tracks[Math.round((index * (tracks.length - 1)) / 31)]!,
      )
}
