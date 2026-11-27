import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { matchComponentDogboneViaSites } from "lib/match-component-dogbone-via-sites"
import { prepareFanoutBuses } from "lib/prepare-buses"

// Diagonal ground pads can meet at one physical interstitial via.
const pads = [
  { x: 0, y: 0 },
  { x: 0.65, y: 0 },
  { x: 0, y: 0.65 },
  { x: 0.65, y: 0.65 },
]
const input = {
  layerCount: 4,
  minTraceWidth: 0.08,
  bounds: { minX: -1, maxX: 2, minY: -1, maxY: 2 },
  obstacles: pads.map((center, index) => ({
    obstacleId: `pad-${index}`,
    componentId: "U1",
    type: "rect" as const,
    shape: "circle" as const,
    center,
    width: 0.35,
    height: 0.35,
    layers: ["top"],
    connectedTo: [index === 0 || index === 3 ? "GND" : `signal-${index}`],
  })),
  connections: [0, 3].map((padIndex) => ({
    name: `ground-${padIndex}`,
    netConnectionName: "GND",
    pointsToConnect: [
      { ...pads[padIndex]!, layer: "top", pcb_port_id: `port-${padIndex}` },
      { x: -1, y: pads[padIndex]!.y, layer: "inner1" },
    ],
  })),
} satisfies SimpleRouteJson

test("coincident same-net dogbones share one physical via", async () => {
  const originalInput = structuredClone(input)
  const buses = prepareFanoutBuses(input, {
    sourceComponentId: "U1",
    defaultDirection: "left",
    sharedBoundary: input.bounds,
    escapeLayers: ["inner1"],
  })
  const graphics: GraphicsObject = {
    title: "Interstitial dogbone via assignment",
    coordinateSystem: "cartesian",
    circles: [],
    lines: [],
    texts: [],
  }
  for (const [panel, scenario] of [
    {
      label: "Same net: one barrel",
      sameNet: true,
      second: { x: 0.325, y: 0.325 },
    },
    {
      label: "Different nets",
      sameNet: false,
      second: { x: 0.325, y: 0.325 },
    },
    {
      label: "Same net: two holes",
      sameNet: true,
      second: { x: 0.35, y: 0.35 },
    },
  ].entries()) {
    const matching = matchComponentDogboneViaSites(buses, {
      viaDiameter: 0.35,
      viaHoleDiameter: 0.15,
      traceWidth: input.minTraceWidth,
      clearance: 0.1,
      holeToHoleClearance: 0.1,
      fixedViaPointsByConnectionIndex: new Map([
        [0, { x: 0.325, y: 0.325 }],
        [1, scenario.second],
      ]),
      canShareCopper: () => scenario.sameNet,
    })
    if (panel === 0) {
      expect([...matching!.values()]).toEqual([
        { x: 0.325, y: 0.325 },
        { x: 0.325, y: 0.325 },
      ])
    } else {
      expect(matching).toBeNull()
    }
    const shift = panel * 2.25
    const drawnViaSites = new Set<string>()
    for (const [index, center] of pads.entries()) {
      graphics.circles!.push({
        center: { x: center.x + shift, y: center.y },
        radius: 0.175,
        fill: index === 0 || index === 3 ? "#16a34a" : "#94a3b8",
      })
    }
    for (const [connectionIndex, point] of matching ?? []) {
      const source = buses
        .flatMap((bus) => bus.connections)
        .find(
          (connection) => connection.connectionIndex === connectionIndex,
        )!.sourcePoint
      graphics.lines!.push({
        points: [
          { x: source.x + shift, y: source.y },
          { x: point.x + shift, y: point.y },
        ],
        strokeColor: "#16a34a",
        strokeWidth: input.minTraceWidth,
      })
      const key = `${point.x},${point.y}`
      if (drawnViaSites.has(key)) continue
      drawnViaSites.add(key)
      graphics.circles!.push(
        {
          center: { x: point.x + shift, y: point.y },
          radius: 0.175,
          fill: "#2563eb",
        },
        {
          center: { x: point.x + shift, y: point.y },
          radius: 0.075,
          fill: "white",
        },
      )
    }
    graphics.texts!.push(
      {
        x: 0.325 + shift,
        y: 1.25,
        text: scenario.label,
        fontSize: 0.1,
      },
      {
        x: 0.325 + shift,
        y: -0.5,
        text: `${matching?.size ?? 0}/2 assigned; ${drawnViaSites.size} vias`,
        fontSize: 0.1,
      },
    )
  }
  expect(input).toEqual(originalInput)
  await expect(
    getSvgFromGraphicsObject(graphics, {
      backgroundColor: "white",
      svgWidth: 1200,
      svgHeight: 420,
    }),
  ).toMatchSvgSnapshot(import.meta.path)
})
