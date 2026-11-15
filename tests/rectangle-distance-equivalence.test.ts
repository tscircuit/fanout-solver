import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import {
  distanceSegmentToObstacle,
  distanceSegmentToSegment,
} from "lib/geometry"
import type { Point2D, RoutedSegment } from "lib/types"

test("rectangle distances preserve edge-by-edge clearance for rotated and degenerate geometry", () => {
  const originalDistance = (
    segment: RoutedSegment,
    obstacle: Obstacle & { ccwRotationDegrees?: number },
  ) => {
    const radians = (-(obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180
    const local = (point: Point2D) => ({
      x:
        (point.x - obstacle.center.x) * Math.cos(radians) -
        (point.y - obstacle.center.y) * Math.sin(radians),
      y:
        (point.x - obstacle.center.x) * Math.sin(radians) +
        (point.y - obstacle.center.y) * Math.cos(radians),
    })
    const start = local(segment.start)
    const end = local(segment.end)
    const inside = (point: Point2D) =>
      Math.abs(point.x) <= obstacle.width / 2 + 1e-9 &&
      Math.abs(point.y) <= obstacle.height / 2 + 1e-9
    if (inside(start) || inside(end)) return 0
    const corners = [
      { x: -obstacle.width / 2, y: -obstacle.height / 2 },
      { x: obstacle.width / 2, y: -obstacle.height / 2 },
      { x: obstacle.width / 2, y: obstacle.height / 2 },
      { x: -obstacle.width / 2, y: obstacle.height / 2 },
    ]
    return Math.min(
      ...corners.map((corner, index) =>
        distanceSegmentToSegment(start, end, corner, corners[(index + 1) % 4]!),
      ),
    )
  }
  const check = (segment: RoutedSegment, obstacle: Obstacle) => {
    const expected = originalDistance(segment, obstacle)
    const actual = distanceSegmentToObstacle(segment, obstacle)
    expect(Math.abs(actual - expected)).toBeLessThan(1e-12)
    // The optimized distance must also preserve practical clearance decisions.
    for (const clearance of [0.05, 0.1, 0.15, 0.2]) {
      expect(actual < clearance - 1e-9).toBe(expected < clearance - 1e-9)
    }
  }
  let seed = 0x62_14_45
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x1_0000_0000
  }
  const obstacle: Obstacle = {
    type: "rect",
    center: { x: 0, y: 0 },
    width: 1,
    height: 1,
    layers: ["top"],
    connectedTo: [],
  }
  for (const offset of [-1e-9, 0, 1e-9, 0.05, 0.1]) {
    for (const width of [0, 1e-6, Math.sqrt(1e-9), 1]) {
      for (const height of [0, 1e-6, Math.sqrt(1e-9), 1]) {
        for (const [start, end] of [
          [
            { x: -2, y: 0 },
            { x: 2, y: 0 },
          ],
          [
            { x: -2, y: height / 2 + offset },
            { x: 2, y: height / 2 + offset },
          ],
          [
            { x: width / 2 + offset, y: 2 },
            { x: width / 2 + offset, y: 2 },
          ],
          [
            { x: -2, y: -2 },
            { x: 2, y: 2 },
          ],
        ])
          check(
            { start: start!, end: end!, width: 0.1, layer: "top" },
            { ...obstacle, width, height },
          )
      }
    }
  }
  for (let index = 0; index < 20_000; index++) {
    const start = { x: random() * 8 - 4, y: random() * 8 - 4 }
    const end =
      index % 10 === 0 ? start : { x: random() * 8 - 4, y: random() * 8 - 4 }
    check({ start, end, width: 0.1, layer: "top" }, {
      ...obstacle,
      center: { x: random() * 4 - 2, y: random() * 4 - 2 },
      width: random() * 2,
      height: random() * 2,
      ccwRotationDegrees: random() * 360,
    } as Obstacle)
  }
})
