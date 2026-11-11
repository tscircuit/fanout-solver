import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import {
  getComponentDogboneViaSiteCandidates,
  matchComponentDogboneViaSites,
} from "lib/match-component-dogbone-via-sites"
import { prepareFanoutBuses } from "lib/prepare-buses"
import fixture from "./fixtures/imported-grid-via-sites.json"

test("imported STM32 pad grid loses legal direct dogbone sites", async () => {
  const input = structuredClone(fixture.inputSrj) as SimpleRouteJson
  const pads = fixture.inputSrj.obstacles.filter(
    (pad) => pad.componentId === "pcb_component_0",
  )
  expect(pads).toHaveLength(354)

  // Full-footprint geometry regression: request one distinct local escape per
  // physical pad, keeping every captured obstacle unchanged. These requests
  // exercise joint site assignment; they are not the motherboard netlist.
  input.connections = pads.map((pad) => ({
    name: pad.circuitJsonMetadata!.source_port_name!,
    pointsToConnect: [
      {
        ...pad.center,
        layer: "top",
        pcb_port_id: pad.circuitJsonMetadata!.pcb_port_id!,
      },
    ],
  }))
  const buses = prepareFanoutBuses(input, {
    sourceComponentId: "pcb_component_0",
    defaultDirection: "down",
    escapeLayers: ["inner3"],
    sharedBoundary: input.bounds,
    buses: [
      {
        busId: "LOCAL_ESCAPES",
        connectionNames: input.connections.map(({ name }) => name),
        termination: { type: "plane", layer: "inner3" },
      },
    ],
  })
  const rules = {
    traceWidth: input.minTraceWidth,
    clearance: input.minTraceToPadEdgeClearance!,
    viaDiameter: input.minViaPadDiameter!,
    viaHoleDiameter: input.minViaHoleDiameter,
    holeToHoleClearance: fixture.inputSrj.minViaHoleEdgeToViaHoleEdgeClearance,
    additionalObstacles: input.obstacles,
  }
  const before = JSON.stringify({ input, buses })
  const candidates = getComponentDogboneViaSiteCandidates(buses, rules)
  const matching = matchComponentDogboneViaSites(buses, rules)
  const candidateIndices = new Set(
    candidates.map(({ connectionIndex }) => connectionIndex),
  )
  const missing = input.connections
    .filter((_, index) => !candidateIndices.has(index))
    .map(({ name }) => name)

  expect(missing).toEqual([
    "A5",
    "A10",
    "A15",
    "E1",
    "K1",
    "K19",
    "R1",
    "W5",
    "W10",
    "W15",
  ])
  expect(matching).toBeNull()
  expect(JSON.stringify({ input, buses })).toBe(before)

  const focus = pads.find(
    (pad) => pad.circuitJsonMetadata!.source_port_name === "A10",
  )!
  const graphics: GraphicsObject = {
    title: "Imported STM32MP157DAB1: direct dogbone via-site assignment",
    coordinateSystem: "cartesian",
    circles: [],
    lines: [],
    rects: [],
    texts: [
      {
        x: 11,
        y: 12,
        text: "Imported STM32 grid: exact-angle via sites",
        fontSize: 0.7,
      },
    ],
  }
  for (const zoom of [false, true]) {
    const shift = zoom ? 22 : 0
    const scale = zoom ? 5 : 1
    const project = (point: { x: number; y: number }) => ({
      x: (point.x - (zoom ? focus.center.x : 0)) * scale + shift,
      y: (point.y - (zoom ? focus.center.y : 0)) * scale,
    })
    graphics.rects!.push({
      center: { x: shift, y: 0 },
      width: 18,
      height: 18,
      fill: "transparent",
      stroke: "#cbd5e1",
    })
    for (const [index, pad] of pads.entries()) {
      if (
        zoom &&
        (Math.abs(pad.center.x - focus.center.x) > 1.3 ||
          Math.abs(pad.center.y - focus.center.y) > 1.3)
      )
        continue
      graphics.circles!.push({
        center: project(pad.center),
        radius: (pad.width / 2) * scale,
        fill:
          pad === focus
            ? "#2563eb"
            : candidateIndices.has(index)
              ? "#cbd5e1"
              : "#dc2626",
      })
      const site = matching?.get(index)
      if (!site) continue
      graphics.lines!.push({
        points: [project(pad.center), project(site)],
        strokeColor: "#16803c",
        strokeWidth: rules.traceWidth * scale,
      })
      graphics.circles!.push({
        center: project(site),
        radius: (rules.viaDiameter / 2) * scale,
        fill: "#16803c",
      })
    }
    graphics.texts!.push({
      x: shift,
      y: 10,
      text: zoom
        ? `A10 enlarged: ${candidates.filter(({ connectionIndex }) => input.connections[connectionIndex]!.name === "A10").length} valid via positions`
        : "All 354 imported pads; joint assignment",
      fontSize: 0.56,
    })
  }
  const status = matching
    ? `${matching.size}/354 via sites assigned; ${missing.length} pads without candidates`
    : `No complete assignment; ${missing.length}/354 pads have zero candidates`
  for (const [index, text] of [
    status,
    "Blue: A10. Red: no usable candidate. Green: selected via and direct escape geometry.",
    "0.15 mm trace; 0.30 mm via pad; 0.15 mm hole; 0.125 mm copper clearance.",
    matching
      ? "Exact 45-degree candidates pass the existing geometry checks."
      : "Midpoint candidates miss 45 degrees; nearby legal positions are not generated.",
    "Full imported footprint, one test escape per pad. Via-site assignments only; no board routing.",
  ].entries())
    graphics.texts!.push({
      x: 11,
      y: -10.5 - index * 1.1,
      text,
      fontSize: index === 0 ? 0.64 : 0.48,
    })
  await expect(
    getSvgFromGraphicsObject(graphics, { svgWidth: 1200, svgHeight: 830 }),
  ).toMatchSvgSnapshot(import.meta.path)
})
