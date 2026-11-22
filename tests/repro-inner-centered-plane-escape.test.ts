import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus } from "lib/route-bus"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiPlaneDrop } from "./fixtures/icepi-plane-drop"

test("native interior U22 pad can reach its ground plane", async () => {
  const params = createIcepiPlaneDrop("ESC_U22_pin115")
  const plans = routeBus(params)
  expect(plans).toHaveLength(1)
  const output = buildOutputSimpleRouteJson({
    inputSrj: params.srj,
    plans: plans ?? [],
    layerNames: params.layerNames,
  })
  const drc = validateRoutedCopperDrc({
    inputSrj: params.srj,
    routedSrj: output,
    clearance: params.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc).toMatchObject({ valid: true, issues: [] })

  const graphics = visualizeSimpleRouteJson({
    ...output,
    obstacles: params.srj.obstacles,
    bounds: params.bus.sharedBoundary,
    connections: [],
  })
  graphics.points = [
    {
      ...params.bus.connections[0]!.sourcePoint,
      label: "U22.115",
      color: "#15803d",
    },
  ]
  graphics.texts = [
    {
      x: params.bus.sharedBoundary.minX,
      y: params.bus.sharedBoundary.maxY + 1,
      text: `iCE/Pi U22.115: ${plans?.length ?? 0}/1 plane escapes; ${drc.checkedViaCount} vias`,
      fontSize: 0.3,
      color: "#0f172a",
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
