import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { routeBus } from "lib/route-bus"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiPlaneDrop } from "./fixtures/icepi-plane-drop"

test("native U22 plane drop retains reserved pours during route search", async (): Promise<void> => {
  const params = createIcepiPlaneDrop()
  const inputBefore = JSON.stringify(params.srj)
  expect(params.viaDiameter).toBe(0.45)
  expect(params.viaHoleDiameter).toBe(0.2)
  expect(params.clearance).toBe(0.1)
  expect(params.srj.allowViaInPad).toBe(false)
  expect(params.srj.obstacles.some((obstacle) => obstacle.isCopperPour)).toBe(true)
  const plans = routeBus(params)
  expect(JSON.stringify(params.srj)).toBe(inputBefore)

  // The fixture keeps every obstacle that can affect the native fanout region.
  // Crop the drawing further without changing the searched geometry.
  const boundary = params.bus.sharedBoundary
  const viewport = {
    minX: boundary.minX - 1.5,
    maxX: boundary.maxX + 1.5,
    minY: boundary.minY - 1.5,
    maxY: boundary.maxY + 1.5,
  }
  const graphics = visualizeSimpleRouteJson({
    ...params.srj,
    bounds: viewport,
    connections: [params.bus.connections[0].connection],
    obstacles: params.srj.obstacles.filter(
      (obstacle) =>
        obstacle.center.x >= viewport.minX &&
        obstacle.center.x <= viewport.maxX &&
        obstacle.center.y >= viewport.minY &&
        obstacle.center.y <= viewport.maxY,
    ),
    traces: plans === null ? [] : plans.map((plan) => plan.trace),
  })
  graphics.texts = [
    {
      x: viewport.minX,
      y: viewport.maxY + 0.8,
      text: `U22 GND plane drop: ${plans === null ? 0 : plans.length}/1 routed`,
      fontSize: 0.3,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: viewport.minX,
      y: viewport.maxY + 0.3,
      text: `${params.srj.obstacles.filter((obstacle) => obstacle.isCopperPour).length} reserved-pour obstacles retained`,
      fontSize: 0.25,
      color: "#475569",
      anchorSide: "center_left",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1000,
      svgHeight: 1000,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
