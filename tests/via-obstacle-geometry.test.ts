import { expect, test } from "bun:test"
import type { Obstacle } from "@tscircuit/capacity-autorouter"
import { distancePointToObstacle } from "lib/geometry"

test("treats multilayer pcb_via obstacles as circular", () => {
  const viaObstacle: Obstacle = {
    type: "rect",
    layers: ["top", "inner1"],
    center: { x: 0, y: 0 },
    width: 0.3,
    height: 0.3,
    connectedTo: ["pcb_via_0", "connectivity_net_0"],
  }

  expect(
    distancePointToObstacle({ x: 0.25, y: 0.25 }, viaObstacle),
  ).toBeCloseTo(Math.hypot(0.25, 0.25) - 0.15, 8)
})

test("does not infer component pads as circular from same-net via ids", () => {
  const componentPadObstacle: Obstacle = {
    componentId: "pcb_component_0",
    type: "rect",
    layers: ["top"],
    center: { x: 0, y: 0 },
    width: 0.3,
    height: 0.3,
    connectedTo: ["pcb_smtpad_0", "pcb_via_0", "connectivity_net_0"],
  }

  expect(
    distancePointToObstacle({ x: 0.25, y: 0.25 }, componentPadObstacle),
  ).toBeCloseTo(Math.hypot(0.1, 0.1), 8)
})
