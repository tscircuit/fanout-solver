import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { distanceSegmentToObstacle, pointIsInsideObstacle } from "lib/geometry"

const rotatedPad = {
  obstacleId: "rotated-pad",
  componentId: "C1",
  type: "rect",
  center: { x: 1, y: 0 },
  width: 2,
  height: 0.2,
  ccwRotationDegrees: 90,
  layers: ["top"],
  connectedTo: ["OTHER_NET"],
} as Obstacle

test("rotated rectangular pads use their oriented geometry for clearance", () => {
  const segment = {
    start: { x: 0, y: 0.5 },
    end: { x: 2, y: 0.5 },
    width: 0.1,
    layer: "top",
  }

  expect(pointIsInsideObstacle({ x: 1, y: 0.5 }, rotatedPad)).toBe(true)
  expect(distanceSegmentToObstacle(segment, rotatedPad)).toBeCloseTo(0, 9)
  expect(
    distanceSegmentToObstacle(segment, {
      ...rotatedPad,
      ccwRotationDegrees: 0,
    } as Obstacle),
  ).toBeCloseTo(0.4, 9)
})
