import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeBus } from "lib/route-bus"
import { getPlanVias } from "lib/route-bus/plan-copper"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("iCE/Pi eMMC B5 can turn into the gap between perimeter pads", async () => {
  // Actual U22 A4:A6/B4:B6 geometry, translated so B5 is at the origin.
  // Board-world points in mm: +X right, +Y up. Widths and spacing are unchanged.
  const bounds = { minX: -0.8, maxX: 0.8, minY: -1.35, maxY: 0.35 }
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds,
    obstacles: [
      ...[-0.5, 0, 0.5].map((x) => ({
        type: "rect" as const,
        shape: "circle" as const,
        center: { x, y: 0 },
        width: 0.24,
        height: 0.24,
        componentId: "U22",
        layers: ["top"],
        connectedTo: [`B${5 - x * 2}`],
      })),
      ...[-0.5, 0, 0.5].map((x) => ({
        type: "rect" as const,
        center: { x, y: -0.5 },
        width: 0.19,
        height: 0.3,
        componentId: "U22",
        layers: ["top"],
        connectedTo: [`A${5 - x * 2}`],
      })),
    ],
    connections: [
      {
        name: "B5",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pointId: "B5", pcb_port_id: "B5" },
          { x: -0.6458, y: -1.3499, layer: "inner1" },
        ],
      },
    ],
  }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.45,
    viaHoleDiameter: 0.2,
    allowBlindAndBuriedVias: false,
  }
  const [bus] = prepareFanoutBuses(srj, { ...rules, sharedBoundary: bounds })
  const plans =
    routeBus({
      ...rules,
      srj,
      bus: bus!,
      targetLayer: "top",
      layerNames: ["top", "inner1", "inner2", "bottom"],
      acceptedPlans: [],
      compactBusTracks: true,
    }) ?? []
  const routedSrj = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames: ["top", "inner1", "inner2", "bottom"],
  })
  expect(
    validateRoutedCopperDrc({ inputSrj: srj, routedSrj, ...rules }),
  ).toMatchObject({ valid: true, issues: [] })
  const graphics = visualizeSimpleRouteJson(routedSrj)
  const viaCount = plans.flatMap(getPlanVias).length
  graphics.texts = [
    {
      x: 0,
      y: 0.8,
      text: `iCE/Pi U22.B5: ${plans.length}/1 escape; ${viaCount} vias`,
      fontSize: 0.12,
      anchorSide: "bottom_center",
      color: "#0f172a",
    },
    {
      x: 0,
      y: 0.55,
      text: "0.5mm pitch | 0.1mm trace and clearance",
      fontSize: 0.09,
      anchorSide: "bottom_center",
      color: "#475569",
    },
  ]
  await expect(
    getSvgFromGraphicsObject(graphics, { backgroundColor: "white" }),
  ).toMatchSvgSnapshot(import.meta.path)
})
