import { expect, spyOn, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus, type RouteBusParams } from "lib/route-bus"
import * as sourcePaths from "lib/route-bus/get-plane-source-escape-paths"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiPlaneDrop } from "./fixtures/icepi-plane-drop"

test("native U22 plane search reuses fully rejected source path groups", async () => {
  const params: RouteBusParams = {
    ...createIcepiPlaneDrop(),
    staticClearanceCache: new Map(),
  }
  // Warm the existing static cache before measuring the repeated search.
  const firstPlans = routeBus(params)
  expect(routeBus(params)).toEqual(firstPlans)

  const groups = spyOn(sourcePaths, "getPlaneSourceEscapePaths")
  const plans = routeBus(params)
  const groupCount = groups.mock.calls.length
  groups.mockRestore()
  expect(plans).toEqual(firstPlans)
  if (!plans) throw new Error("Native U22 ground escape is missing")
  expect(plans).toHaveLength(1)

  const output = buildOutputSimpleRouteJson({
    inputSrj: params.srj,
    plans,
    layerNames: params.layerNames,
  })
  const drc = validateRoutedCopperDrc({
    inputSrj: params.srj,
    routedSrj: output,
    clearance: params.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc).toMatchObject({ valid: true, checkedViaCount: 1, issues: [] })

  const graphics = visualizeSimpleRouteJson({
    ...output,
    obstacles: params.srj.obstacles,
    bounds: params.bus.sharedBoundary,
    connections: [],
  })
  graphics.texts = [
    {
      x: params.bus.sharedBoundary.minX,
      y: params.bus.sharedBoundary.maxY + 2,
      text: "iCE/Pi U22 pin101: ground escape; 1 via",
      fontSize: 0.25,
      color: "#0f172a",
      anchorSide: "center_left",
    },
    {
      x: params.bus.sharedBoundary.minX,
      y: params.bus.sharedBoundary.maxY + 1.5,
      text: `Source path groups visited in repeated search: ${groupCount}`,
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
