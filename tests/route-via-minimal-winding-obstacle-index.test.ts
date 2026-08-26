import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { distanceSegmentToObstacle } from "lib/geometry"
import { ObstacleSpatialIndex } from "lib/route-via-minimal-winding"
import type { RoutedSegment } from "lib/types"

function makeObstacle(params: {
  obstacleId: string
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  circle?: boolean
}): Obstacle {
  return {
    obstacleId: params.obstacleId,
    type: "rect",
    center: { x: params.x, y: params.y },
    width: params.width,
    height: params.height,
    layers: ["inner1"],
    connectedTo: [],
    ...(params.rotation === undefined
      ? {}
      : { ccwRotationDegrees: params.rotation }),
    ...(params.circle ? { shape: "circle" } : {}),
  } as Obstacle
}

test("obstacle spatial index preserves every exact clearance collision", () => {
  const obstacles = [
    makeObstacle({
      obstacleId: "axis-aligned",
      x: 0,
      y: 0,
      width: 1,
      height: 2,
    }),
    makeObstacle({
      obstacleId: "rotated-long",
      x: 5,
      y: 5,
      width: 6,
      height: 0.2,
      rotation: 45,
    }),
    makeObstacle({
      obstacleId: "circle",
      x: -4,
      y: 2,
      width: 2,
      height: 2,
      circle: true,
    }),
    makeObstacle({
      obstacleId: "distant",
      x: 100,
      y: 100,
      width: 1,
      height: 1,
    }),
  ]
  const index = new ObstacleSpatialIndex(obstacles)
  const margin = 0.15
  const segments: RoutedSegment[] = [
    {
      start: { x: -1, y: 0 },
      end: { x: 1, y: 0 },
      width: 0.1,
      layer: "inner1",
    },
    {
      start: { x: 3, y: 3 },
      end: { x: 3.5, y: 3.5 },
      width: 0.1,
      layer: "inner1",
    },
    {
      start: { x: -5.5, y: 2 },
      end: { x: -4.9, y: 2 },
      width: 0.1,
      layer: "inner1",
    },
    {
      start: { x: 20, y: -2 },
      end: { x: 21, y: -2 },
      width: 0.1,
      layer: "inner1",
    },
  ]

  for (const segment of segments) {
    const candidates = new Set(index.querySegment(segment, margin))
    for (const obstacle of obstacles) {
      if (distanceSegmentToObstacle(segment, obstacle) < margin) {
        expect(candidates.has(obstacle)).toBe(true)
      }
    }
  }

  const rotatedCandidates = index.querySegment(segments[1]!, margin)
  expect(rotatedCandidates.map((obstacle) => obstacle.obstacleId)).toContain(
    "rotated-long",
  )
  expect(
    rotatedCandidates.map((obstacle) => obstacle.obstacleId),
  ).not.toContain("distant")
})
