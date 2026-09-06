import { expect, test } from "bun:test"
import { distancePointToSegment, segmentsAreClear } from "lib/geometry"
import { RouteSegmentSpatialIndex } from "lib/route-segment-spatial-index"
import type { RoutedSegment, RoutedVia } from "lib/types"

test("segment broad phase retains every exact trace and spanning-via collision", () => {
  let seed = 230
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const segment = (): RoutedSegment => {
    const x = random() * 40 - 20,
      y = random() * 40 - 20
    return {
      start: { x, y },
      end: { x: x + random() * 4 - 2, y: y + random() * 4 - 2 },
      width: 0.02 + random() * 0.5,
      layer: ["top", "inner1", "bottom"][Math.floor(random() * 3)]!,
    }
  }
  const segments = Array.from({ length: 500 }, segment)
  segments.push({
    start: { x: -100, y: 0 },
    end: { x: 100, y: 0 },
    width: 0.1,
    layer: "top",
  })
  const index = new RouteSegmentSpatialIndex(segments)
  let collisions = 0,
    discarded = 0
  for (let attempt = 0; attempt < 150; attempt++) {
    const trace = segment(),
      clearance = random() * 0.3
    const candidates = new Set(index.querySegment(trace, clearance))
    discarded += segments.length - candidates.size
    for (const other of segments)
      if (!segmentsAreClear(trace, other, clearance)) {
        collisions++
        expect(candidates.has(other)).toBe(true)
      }
    const via: RoutedVia = {
      center: trace.start,
      diameter: 0.1 + random(),
      holeDiameter: 0.05,
      fromLayer: "top",
      toLayer: "bottom",
      spanLayers: ["top", "inner1", "bottom"],
    }
    const viaCandidates = new Set(index.queryVia(via, clearance))
    for (const other of segments)
      if (
        distancePointToSegment(via.center, other.start, other.end) <
        (via.diameter + other.width) / 2 + clearance - 1e-9
      ) {
        collisions++
        expect(viaCandidates.has(other)).toBe(true)
      }
  }
  const boundary = segments.at(-1)!
  for (const delta of [-2e-9, -1e-9, 0, 1e-9, 2e-9]) {
    const trace = {
      ...boundary,
      start: { x: 0, y: 0.2 + delta },
      end: { x: 1, y: 0.2 + delta },
    }
    if (!segmentsAreClear(trace, boundary, 0.1))
      expect(index.querySegment(trace, 0.1)).toContain(boundary)
  }
  expect(collisions).toBeGreaterThan(50)
  expect(discarded).toBeGreaterThan(70_000)
})
