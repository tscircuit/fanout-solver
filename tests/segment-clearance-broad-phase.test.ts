import { expect, test } from "bun:test"
import { distanceSegmentToSegment, segmentsAreClear } from "lib/geometry"
import type { RoutedSegment } from "lib/types"

test("segment clearance broad phase preserves the exact distance predicate", () => {
  const createSegment = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width = 0.1,
    layer = "top",
  ): RoutedSegment => ({
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    width,
    layer,
  })
  const originalPredicate = (
    first: RoutedSegment,
    second: RoutedSegment,
    clearance: number,
  ): boolean =>
    first.layer !== second.layer ||
    distanceSegmentToSegment(
      first.start,
      first.end,
      second.start,
      second.end,
    ) >=
      (first.width + second.width) / 2 + clearance - 1e-9
  const check = (
    first: RoutedSegment,
    second: RoutedSegment,
    clearance: number,
  ): void => {
    for (const [a, b] of [
      [first, second],
      [second, first],
      [{ ...first, start: first.end, end: first.start }, second],
    ]) {
      expect(segmentsAreClear(a, b, clearance)).toBe(
        originalPredicate(a, b, clearance),
      )
    }
  }

  // Keep boundary cases near the existing 1e-9 clearance tolerance, including
  // translated coordinates, zero-length segments and 45-degree corners.
  for (const origin of [-1000, 0, 1000]) {
    const horizontal = createSegment(origin, origin, origin + 1, origin)
    for (const delta of [-2e-9, -1e-9, -0.5e-9, 0, 0.5e-9, 1e-9, 2e-9]) {
      const gap = 0.2 + delta
      check(
        horizontal,
        createSegment(origin, origin + gap, origin + 1, origin + gap),
        0.1,
      )
      check(
        horizontal,
        createSegment(origin + 1 + gap, origin, origin + 2 + gap, origin),
        0.1,
      )
      check(
        createSegment(origin, origin, origin, origin),
        createSegment(origin + gap, origin, origin + gap, origin),
        0.1,
      )
      check(
        createSegment(origin, origin, origin + 1, origin + 1),
        createSegment(
          origin - gap / Math.SQRT2,
          origin + gap / Math.SQRT2,
          origin + 1 - gap / Math.SQRT2,
          origin + 1 + gap / Math.SQRT2,
        ),
        0.1,
      )
    }
    check(
      horizontal,
      createSegment(origin, origin + 1, origin + 1, origin - 1),
      0.1,
    )
    check(
      horizontal,
      createSegment(origin + 1, origin, origin + 2, origin + 1),
      0,
    )
    check(
      horizontal,
      createSegment(origin, origin, origin + 1, origin, 1, "bottom"),
      1,
    )
    check(
      createSegment(origin, origin, origin + 1e-6, origin + 1e-6),
      createSegment(origin + 0.2, origin, origin + 0.2, origin + 1),
      0.1,
    )
  }

  let seed = 0x62_14_45
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x1_0000_0000
  }
  const randomSegment = (): RoutedSegment => {
    const x = random() * 100 - 50
    const y = random() * 100 - 50
    const length = random() * 20
    const direction = Math.floor(random() * 10)
    const deltaX =
      direction < 8
        ? [1, 1, 0, -1, -1, -1, 0, 1][direction]! * length
        : random() * 20 - 10
    const deltaY =
      direction < 8
        ? [0, 1, 1, 1, 0, -1, -1, -1][direction]! * length
        : random() * 20 - 10
    return createSegment(
      x,
      y,
      direction === 8 ? x : x + deltaX,
      direction === 8 ? y : y + deltaY,
      random(),
      random() < 0.1 ? "bottom" : "top",
    )
  }
  for (let index = 0; index < 20_000; index++) {
    check(randomSegment(), randomSegment(), random())
  }
})
