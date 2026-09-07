import { distance, distanceSegmentToSegment } from "./geometry"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import type { FanoutRoutePlan, PreparedBus } from "./types"

/** Additional source-cache and straight/45-degree invariants for reserved routing.
 * Original solution and emitted-copper validators still run separately. */
export function plansPreserveSourcesAndCorners(params: {
  plans: readonly FanoutRoutePlan[]
  preparedBuses: readonly PreparedBus[]
  sourceEscapes: readonly PeripheralSourceEscape[]
}): boolean {
  const connections = new Map(
    params.preparedBuses.flatMap((bus) =>
      bus.connections.map(
        (connection) => [connection.connectionIndex, connection] as const,
      ),
    ),
  )
  const sources = new Map(
    params.sourceEscapes.map((source) => [source.connectionIndex, source]),
  )
  const seen = new Set<number>()
  for (const plan of params.plans) {
    const connection = connections.get(plan.connectionIndex)
    const source = sources.get(plan.connectionIndex)
    if (
      !connection ||
      !source ||
      seen.has(plan.connectionIndex) ||
      plan.sourceObstacle !== connection.sourceObstacle ||
      distance(plan.sourcePoint, connection.sourcePoint) > 1e-7 ||
      distance(plan.targetPoint, connection.targetPoint) > 1e-7
    )
      return false
    seen.add(plan.connectionIndex)
    const count = plan.sourceEscapeSegmentCount ?? 1
    if (
      count !== source.segments.length ||
      count > plan.segments.length ||
      !plan.via ||
      distance(plan.via.center, source.via.center) > 1e-7 ||
      plan.via.diameter !== source.via.diameter ||
      plan.via.holeDiameter !== source.via.holeDiameter ||
      JSON.stringify(plan.via.spanLayers) !==
        JSON.stringify(source.via.spanLayers)
    )
      return false
    for (let i = 0; i < plan.segments.length; i++) {
      const segment = plan.segments[i]!
      if (i < count) {
        const expected = source.segments[i]!
        if (
          segment.layer !== expected.layer ||
          segment.width !== expected.width ||
          distance(segment.start, expected.start) > 1e-7 ||
          distance(segment.end, expected.end) > 1e-7
        )
          return false
      }
      const dx = segment.end.x - segment.start.x
      const dy = segment.end.y - segment.start.y
      const length = Math.hypot(dx, dy)
      if (
        !Number.isFinite(length) ||
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ) > 1e-7
      )
        return false
      const previous = plan.segments[i - 1]
      if (previous) {
        if (distance(previous.end, segment.start) > 1e-7) return false
        const px = previous.end.x - previous.start.x
        const py = previous.end.y - previous.start.y
        const denominator = length * Math.hypot(px, py)
        if (
          previous.layer === segment.layer &&
          denominator > 1e-12 &&
          (dx * px + dy * py) / denominator < Math.SQRT1_2 - 1e-7
        )
          return false
      }
      for (let j = 0; j < i - 1; j++) {
        const other = plan.segments[j]!
        if (
          segment.layer === other.layer &&
          distanceSegmentToSegment(
            segment.start,
            segment.end,
            other.start,
            other.end,
          ) < 1e-8
        )
          return false
      }
    }
  }
  return true
}
