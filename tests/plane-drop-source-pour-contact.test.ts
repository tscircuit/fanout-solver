import { beforeAll, expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { fanoutPlansAreClear } from "lib/route-bus"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"
import { createCapacitorPlaneContact } from "./fixtures/capacitor-plane-contact"

const { inputSrj, plan, rules } = createCapacitorPlaneContact()

beforeAll(async () => {
  const graphics = visualizeSimpleRouteJson({
    ...inputSrj,
    traces: [plan.trace],
  })
  graphics.rects ??= []
  graphics.rects.unshift({
    center: { x: 0, y: 0 },
    width: 0.4,
    height: 0.8,
    fill: "rgba(0,160,80,0.25)",
    stroke: "#15803d",
  })
  graphics.texts ??= []
  graphics.texts.push(
    { x: -1.5, y: 0.7, text: "C1 0402", fontSize: 0.16, anchorSide: "center" },
    {
      x: 0,
      y: 0.85,
      text: "Top GND island",
      fontSize: 0.16,
      anchorSide: "center",
    },
    {
      x: 1,
      y: 0.5,
      text: "Via to inner1 GND",
      fontSize: 0.16,
      anchorSide: "center",
    },
    {
      x: -0.5,
      y: -0.9,
      text: `Same-net plane trace contact accepted: ${fanoutPlansAreClear({ ...rules, plans: [plan] })}`,
      fontSize: 0.18,
      anchorSide: "center",
    },
  )
  await expect(
    getSvgFromGraphicsObject(graphics, { svgWidth: 1000, svgHeight: 400 }),
  ).toMatchSvgSnapshot(import.meta.path)
})

test.failing("a capacitor ground stub can join a same-net source-layer pour before dropping to inner1", () => {
  expect(fanoutPlansAreClear({ ...rules, plans: [plan] })).toBe(true)
})
