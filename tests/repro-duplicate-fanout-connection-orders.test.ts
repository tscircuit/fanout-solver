import { expect, spyOn, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus, type RouteBusStaticClearanceCache } from "lib/route-bus"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiPlaneDrop } from "./fixtures/icepi-plane-drop"

test("native U22 plane search repeats identical singleton connection orders", async () => {
  const params = createIcepiPlaneDrop()
  const originalInput = JSON.stringify(params.srj)
  const staticClearanceCache: RouteBusStaticClearanceCache = new Map()
  const clearanceReads = spyOn(staticClearanceCache, "get")
  const plans = routeBus({ ...params, staticClearanceCache })
  const lookupCount = clearanceReads.mock.calls.length
  clearanceReads.mockRestore()
  expect(JSON.stringify(params.srj)).toBe(originalInput)
  expect(plans).toHaveLength(1)
  if (!plans) throw new Error("Native U22 plane escape was rejected")
  expect(plans[0].via).toMatchObject({
    diameter: 0.45,
    holeDiameter: 0.2,
    spanLayers: ["top", "inner1", "inner2", "bottom"],
  })
  const output = buildOutputSimpleRouteJson({
    inputSrj: params.srj,
    plans,
    layerNames: params.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: params.srj,
      routedSrj: output,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  const boundary = params.bus.sharedBoundary
  const graphics = visualizeSimpleRouteJson({
    ...output,
    bounds: boundary,
    connections: [],
  })
  graphics.texts = [
    {
      x: boundary.minX,
      y: boundary.maxY + 0.8,
      text: "iCE/Pi U22 plane escape: 1 route; 1 through-via",
      fontSize: 0.3,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: boundary.minX,
      y: boundary.maxY + 0.3,
      text: `Static clearance lookups: ${lookupCount}`,
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
