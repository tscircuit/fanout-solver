import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import {
  distancePointToObstacle,
  distanceSegmentToObstacle,
} from "lib/geometry"
import { ObstacleSpatialIndex } from "lib/obstacle-spatial-index"
import type { RoutedSegment, RoutedVia } from "lib/types"

test("obstacle broad phase preserves rotated-pad, circle, and spanning-via collisions", () => {
  let seed = 3352
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const obstacles: Obstacle[] = Array.from({ length: 500 }, (_, i) => ({
    type: "rect" as const,
    center: { x: random() * 40 - 20, y: random() * 40 - 20 },
    width: random() * 2 + 0.05,
    height: random() * 2 + 0.05,
    layers:
      i % 3 === 0
        ? ["top", "inner1", "bottom"]
        : [["top", "inner1", "bottom"][i % 3]!],
    connectedTo: [],
    ccwRotationDegrees: random() * 360,
    ...(i % 4 === 0 ? { shape: "circle" } : {}),
  }))
  const rotated: Obstacle = {
    type: "rect",
    center: { x: 0, y: 0 },
    width: 4,
    height: 0.1,
    layers: ["inner1"],
    connectedTo: [],
    ccwRotationDegrees: 45,
  }
  obstacles.push(rotated)
  const index = new ObstacleSpatialIndex(obstacles)
  let collisions = 0,
    discarded = 0
  for (let i = 0; i < 200; i++) {
    const x = random() * 40 - 20,
      y = random() * 40 - 20
    const segment: RoutedSegment = {
      start: { x, y },
      end: { x: x + random() * 5 - 2.5, y: y + random() * 5 - 2.5 },
      width: random() * 0.4 + 0.05,
      layer: ["top", "inner1", "bottom"][i % 3]!,
    }
    const clearance = random() * 0.3
    const candidates = new Set(index.querySegment(segment, clearance))
    discarded += obstacles.length - candidates.size
    for (const obstacle of obstacles) {
      if (
        obstacle.layers.includes(segment.layer) &&
        distanceSegmentToObstacle(segment, obstacle) <
          segment.width / 2 + clearance - 1e-9
      ) {
        collisions++
        expect(candidates.has(obstacle)).toBe(true)
      }
    }
    const via: RoutedVia = {
      center: segment.start,
      diameter: random() + 0.1,
      holeDiameter: 0.05,
      fromLayer: "top",
      toLayer: "bottom",
      spanLayers: ["top", "inner1", "bottom"],
    }
    const viaCandidates = index.queryVia(via, clearance)
    expect(new Set(viaCandidates).size).toBe(viaCandidates.length)
    for (const obstacle of obstacles) {
      if (
        distancePointToObstacle(via.center, obstacle) <
        via.diameter / 2 + clearance - 1e-9
      ) {
        collisions++
        expect(viaCandidates).toContain(obstacle)
      }
    }
  }
  const tip: RoutedSegment = {
    start: { x: 1.4, y: 1.4 },
    end: { x: 1.45, y: 1.45 },
    layer: "inner1",
    width: 0.1,
  }
  expect(distanceSegmentToObstacle(tip, rotated)).toBe(0)
  expect(index.querySegment(tip, 0)).toContain(rotated)
  expect(index.querySegment({ ...tip, layer: "top" }, 0)).not.toContain(rotated)
  expect(collisions).toBeGreaterThan(150)
  expect(discarded).toBeGreaterThan(98_000)
})
