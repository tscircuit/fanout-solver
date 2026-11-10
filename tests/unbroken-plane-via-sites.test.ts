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

function panel(
  result: ReturnType<typeof matchSites>,
  x: number,
  unbroken: boolean,
) {
  const plane = reserved.input.obstacles.find((o) => "isCopperPour" in o)!
  const pads = result.buses[0]!.componentObstacles
  const source = result.buses[0]!.connections[0]!.sourceObstacle
  const graphics: GraphicsObject = {
    // A common frame keeps both panels at the same scale. Red is the actual
    // captured pour obstacle; the ordinary case has no reserved obstacle.
    rects: [
      {
        center: plane.center,
        width: plane.width,
        height: plane.height,
        fill: unbroken ? "rgba(200,40,40,0.14)" : "transparent",
        stroke: "#cbd5e1",
      },
    ],
    circles: [
      ...pads.map((pad) => ({
        center: pad.center,
        radius: pad.width / 2,
        fill: pad === source ? "#2563eb" : "#cbd5e1",
        stroke: "#475569",
      })),
      ...result.candidates.map(({ point }) => ({
        center: point,
        radius: result.rules.viaDiameter / 2,
        fill: "#fed7aa",
        stroke: "#d97706",
      })),
      ...[...(result.matching?.values() ?? [])].map((point) => ({
        center: point,
        radius: result.rules.viaDiameter / 2,
        fill: "#d97706",
        stroke: "#92400e",
      })),
    ],
  }
  const svg = getSvgFromGraphicsObject(graphics, {
    svgWidth: 560,
    svgHeight: 340,
  }).replace(/<svg\b/, `<svg x="${x}" y="145"`)
  return `
    <text x="${x}" y="88" font-size="22" font-weight="bold">${unbroken ? "REPRO: unbroken = true" : "CONTROL: unbroken = false"}</text>
    <text x="${x}" y="120" font-size="19">${result.candidates.length} candidate sites; ${result.matching === null ? "assignment = null" : `${result.matching.size} assigned site`}</text>
    ${svg}
  `
}

test("repro: reserved inner1 GND eliminates legal SIGNAL via sites", async () => {
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
  expect(repro.matching).toBeNull()
  expect(repro.candidates).toHaveLength(0)

  await expect(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="660" viewBox="0 0 1200 660">
    <rect width="1200" height="660" fill="white"/>
    <g font-family="sans-serif" fill="#182230">
      <text x="28" y="40" font-size="25" font-weight="bold">fanout-solver: a reserved ground plane blocks via-site assignment</text>
      ${panel(control, 28, false)}
      ${panel(repro, 612, true)}
      <text x="28" y="512" font-size="18">Blue: top SIGNAL pad. Light orange: returned candidates. Dark orange: selected site.</text>
      <text x="28" y="545" font-size="18">Red: inner1 GND reserved obstacle. Both TSX boards contain GND; only unbroken changes.</text>
      <text x="28" y="578" font-size="18">Expected: a SIGNAL via can cross inner1 on its way to inner2, with a copper-free ring in GND.</text>
      <text x="28" y="611" font-size="18">Actual: viaSiteClearsObstacles rejects every candidate inside the reserved pour region.</text>
      <text x="28" y="642" font-size="16">Direct helper output only. No dogbone-solver dependency, saved routes, routed copper, or antipad output.</text>
    </g>
  </svg>`).toMatchSvgSnapshot(import.meta.path)
})
