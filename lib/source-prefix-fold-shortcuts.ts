import { distance } from "./geometry"
import { changedFanoutCopperIsSelfClear } from "./normalize-fanout-plan-corners"
import type { FanoutRoutePlan, Point2D } from "./types"

/**
 * Remove one short returning arm from a private source prefix. The caller must
 * normalize each proposal and check all pads, retained copper, and physical
 * vias. Never change a layer transition or the first via's coordinates.
 */
export function* sourcePrefixFoldShortcuts(
  plan: FanoutRoutePlan,
  clearance: number,
): Generator<Point2D[]> {
  const count = plan.sourceEscapeSegmentCount ?? 1
  const prefix = plan.segments.slice(0, count)
  const first = prefix
    .slice(0, 64)
    .findIndex(
      (_, index) =>
        !changedFanoutCopperIsSelfClear(
          plan,
          plan.segments,
          clearance,
          new Set([index]),
        ),
    )
  if (first < 0) return
  const pitch = prefix[first]!.width + clearance
  // At most four starts, eight ends, and two axis/45 orderings: 64 proposals.
  for (let start = first; start >= Math.max(0, first - 3); start--) {
    let length = 0
    for (let end = start; end < Math.min(prefix.length, first + 8); end++) {
      const segment = prefix[end]!
      if (
        segment.layer !== plan.sourceLayer ||
        (end > start && distance(prefix[end - 1]!.end, segment.start) > 1e-7)
      )
        break
      length += distance(segment.start, segment.end)
      if (length > 4 * pitch + 1e-7) break
      if (end <= first) continue
      const a = prefix[start]!.start,
        b = segment.end,
        dx = b.x - a.x,
        dy = b.y - a.y,
        diagonal = Math.min(Math.abs(dx), Math.abs(dy))
      for (const bend of [
        {
          x: a.x + Math.sign(dx) * diagonal,
          y: a.y + Math.sign(dy) * diagonal,
        },
        {
          x: b.x - Math.sign(dx) * diagonal,
          y: b.y - Math.sign(dy) * diagonal,
        },
      ]) {
        if (distance(a, bend) + distance(bend, b) >= length - 1e-7) continue
        yield [
          prefix[0]!.start,
          ...prefix.slice(0, start).map((s) => s.end),
          bend,
          b,
          ...prefix.slice(end + 1).map((s) => s.end),
        ].filter((p, i, all) => i === 0 || distance(p, all[i - 1]!) > 1e-7)
      }
    }
  }
}
