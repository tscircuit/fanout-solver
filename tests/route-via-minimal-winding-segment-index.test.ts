import { expect, test } from "bun:test"
import { distanceSegmentToSegment } from "lib/geometry"
import {
  type BlockingSegment,
  BlockingSegmentSpatialIndex,
} from "lib/route-via-minimal-winding"
import type { RoutedSegment } from "lib/types"

const makeSegment = (
  start: [number, number],
  end: [number, number],
  width: number,
): RoutedSegment => ({
  start: { x: start[0], y: start[1] },
  end: { x: end[0], y: end[1] },
  width,
  layer: "inner1",
})

test("blocking segment spatial index preserves exact clearance decisions", () => {
  const blockers: BlockingSegment[] = [
    {
      connectionName: "horizontal",
      segment: makeSegment([-4, 0], [4, 0], 0.1),
    },
    { connectionName: "diagonal", segment: makeSegment([3, 3], [7, 7], 0.3) },
    {
      connectionName: "vertical",
      segment: makeSegment([-3, -5], [-3, -2], 0.5),
    },
    {
      connectionName: "distant",
      segment: makeSegment([100, 100], [101, 101], 1),
    },
  ]
  const queries = [
    makeSegment([-1, -1], [-1, 1], 0.12),
    makeSegment([4, 5], [6, 5], 0.08),
    makeSegment([-4, -3], [-2, -3], 0.2),
    makeSegment([20, 20], [21, 21], 0.1),
  ]
  const clearance = 0.15
  const index = new BlockingSegmentSpatialIndex(blockers)

  for (const query of queries) {
    const indexedCandidates = index.querySegment(query, clearance)
    const bruteBlocked = blockers.some(
      (blocker) =>
        distanceSegmentToSegment(
          query.start,
          query.end,
          blocker.segment.start,
          blocker.segment.end,
        ) <
        (query.width + blocker.segment.width) / 2 + clearance,
    )
    const indexedBlocked = indexedCandidates.some(
      (blocker) =>
        distanceSegmentToSegment(
          query.start,
          query.end,
          blocker.segment.start,
          blocker.segment.end,
        ) <
        (query.width + blocker.segment.width) / 2 + clearance,
    )
    expect(indexedBlocked).toBe(bruteBlocked)
  }

  expect(
    index
      .querySegment(queries[0]!, clearance)
      .map((blocker) => blocker.connectionName),
  ).not.toContain("distant")
})
