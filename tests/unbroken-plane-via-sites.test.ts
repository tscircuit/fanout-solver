import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import {
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaSites,
} from "lib/match-component-dogbone-via-sites"
import { prepareFanoutBuses } from "lib/prepare-buses"
import ordinary from "./fixtures/unbroken-plane-ordinary.json"
import reserved from "./fixtures/unbroken-plane-reserved.json"

// Unchanged native inputs captured with core 0.0.2323 / props 0.0.724.
// Explicit TSX source and capture script: https://github.com/tscircuit/dogbone-solver/tree/4780f6a5a70dcde7432baca3c0f7427556546ae7/examples
function matchSites(capture: typeof ordinary | typeof reserved) {
  const input = structuredClone(capture.input)
  const srj = input as SimpleRouteJson
  const buses = prepareFanoutBuses(srj, {
    sourceComponentId: "pcb_component_0",
    defaultDirection: "down",
    escapeLayers: capture.fanoutRoutingLayers,
    sharedBoundary: input.bounds,
  })
  const rules = {
    traceWidth: input.minTraceWidth,
    clearance: input.minTraceToPadEdgeClearance,
    viaDiameter: input.minViaPadDiameter,
    viaHoleDiameter: input.minViaHoleDiameter,
    holeToHoleClearance: input.minViaHoleEdgeToViaHoleEdgeClearance,
    additionalObstacles: srj.obstacles,
  }
  return {
    buses,
    rules,
    candidates: getComponentDogboneViaSiteCandidates(buses, rules),
    matching: matchComponentDogboneViaSites(buses, rules),
  }
}

test("reserved inner1 GND preserves legal SIGNAL via sites", async () => {
  const control = matchSites(ordinary)
  const repro = matchSites(reserved)

  // Compare copies only: both helpers receive every captured obstacle.
  expect({
    ...reserved,
    input: {
      ...reserved.input,
      obstacles: reserved.input.obstacles.filter((o) => !("isCopperPour" in o)),
    },
  }).toEqual(ordinary)
  expect(repro.buses).toEqual(control.buses)
  expect(control.matching?.size).toBe(1)
  expect(control.candidates.length).toBeGreaterThan(0)
  expect(repro.matching).toEqual(control.matching)
  expect(repro.candidates).toEqual(control.candidates)

  const plane = reserved.input.obstacles.find((o) => "isCopperPour" in o)!
  const graphics: GraphicsObject = {
    title: "Reserved ground plane permits native via-site assignment",
    coordinateSystem: "cartesian",
    rects: [],
    circles: [],
    texts: [],
  }
  for (const [panel, result] of [control, repro].entries()) {
    const shift = panel * 8
    const source = result.buses[0]!.connections[0]!.sourceObstacle
    // Same frame in both panels; only the reserved pour is shaded red.
    graphics.rects!.push({
      center: { x: plane.center.x + shift, y: plane.center.y },
      width: plane.width,
      height: plane.height,
      fill: panel ? "rgba(200,40,40,0.14)" : "transparent",
      stroke: "#cbd5e1",
    })
    for (const pad of result.buses[0]!.componentObstacles)
      graphics.circles!.push({
        center: { x: pad.center.x + shift, y: pad.center.y },
        radius: pad.width / 2,
        fill: pad === source ? "#2563eb" : "#cbd5e1",
      })
    for (const { point } of result.candidates)
      graphics.circles!.push({
        center: { x: point.x + shift, y: point.y },
        radius: result.rules.viaDiameter / 2,
        fill: "#fed7aa",
      })
    for (const point of result.matching?.values() ?? [])
      graphics.circles!.push({
        center: { x: point.x + shift, y: point.y },
        radius: result.rules.viaDiameter / 2,
        fill: "#d97706",
      })
    graphics.texts!.push(
      {
        x: plane.center.x + shift,
        y: 2.8,
        text: panel ? "RESERVED: unbroken = true" : "CONTROL: unbroken = false",
        fontSize: 0.3,
      },
      {
        x: plane.center.x + shift,
        y: 2.3,
        text: `${result.candidates.length} candidate sites; ${result.matching === null ? "assignment = null" : `${result.matching.size} assigned site`}`,
        fontSize: 0.25,
      },
    )
  }
  for (const [index, text] of [
    "Blue: top SIGNAL pad. Light orange: candidates. Dark orange: selected site.",
    "Red: reserved inner1 GND region. Both original TSX boards contain a GND pour.",
    "Expected: SIGNAL crosses inner1 through a via, with a copper-free ring in GND.",
    "Both cases return the same four candidates and select the same via site.",
    "Via-site matcher output only; no generated copper or antipads are shown.",
  ].entries())
    graphics.texts!.push({
      x: 2,
      y: -2.6 - index * 0.45,
      text,
      fontSize: 0.24,
    })
  await expect(
    getSvgFromGraphicsObject(graphics, { svgWidth: 1200, svgHeight: 720 }),
  ).toMatchSvgSnapshot(import.meta.path)
})
