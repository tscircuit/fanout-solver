import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus } from "lib/route-bus"
import { planIsClearOfPlans } from "lib/route-bus/plan-mutual-clearance"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createIcepiPlaneDrop } from "./fixtures/icepi-plane-drop"

test("native GND drops retain drill spacing when their copper touches", async () => {
  const first = createIcepiPlaneDrop("ESC_U22_pin65")
  const second = createIcepiPlaneDrop("ESC_U22_pin54")
  const retainedPlan = routeBus(first)![0]!
  const candidatePlan = routeBus(second)![0]!
  const clear = planIsClearOfPlans({
    plan: candidatePlan,
    otherPlans: [retainedPlan],
    srj: first.srj,
    clearance: first.clearance,
    allowSameNetMerges: false,
  })
  expect(clear).toBe(false)
  const plans = clear ? [retainedPlan, candidatePlan] : [retainedPlan]
  const output = buildOutputSimpleRouteJson({
    inputSrj: first.srj,
    plans,
    layerNames: first.layerNames,
  })
  const graphics = visualizeSimpleRouteJson({
    ...output,
    connections: [],
    bounds: { minX: 0.5, maxX: 3.5, minY: 12, maxY: 15 },
    obstacles: first.srj.obstacles.filter(
      ({ center }) =>
        center.x >= 0.5 && center.x <= 3.5 && center.y >= 12 && center.y <= 15,
    ),
  })
  graphics.points = [
    {
      ...candidatePlan.sourcePoint,
      label: "U22.54 / GND",
      color: clear ? "#15803d" : "#b91c1c",
    },
  ]
  graphics.texts = [
    {
      x: 2.15,
      y: 13.1,
      text: clear ? "U22.54: connected" : "U22.54: blocked",
      fontSize: 0.1,
      color: clear ? "#15803d" : "#b91c1c",
      anchorSide: "center_left",
    },
    {
      x: 0.5,
      y: 15.4,
      text: `iCE/Pi GND: ${plans.length}/2 plane drops; 0.50mm via centers`,
      fontSize: 0.12,
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
