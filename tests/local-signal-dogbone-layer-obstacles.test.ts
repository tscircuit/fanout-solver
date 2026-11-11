import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { routeLocalSignalDogbones, validateRoutedCopperDrc } from "lib"

function fixture(): SimpleRouteJson {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    connections: [],
    obstacles: [],
  }
  for (const [componentId, x] of [
    ["U1", -2],
    ["U2", 2],
  ] as const)
    for (let i = 0; i < 4; i++)
      input.obstacles.push({
        type: "rect",
        componentId,
        layers: ["top"],
        center: {
          x: x + (i % 2) * 0.8 - 0.4,
          y: Math.floor(i / 2) * 0.8 - 0.4,
        },
        width: 0.4,
        height: 0.4,
        connectedTo: [`${componentId}_${i}`],
      })
  input.connections = [
    {
      name: "signal",
      pointsToConnect: [input.obstacles[0]!, input.obstacles[4]!].map((o) => ({
        ...o.center,
        layer: "top",
        pcb_port_id: o.connectedTo[0],
      })),
    },
  ]
  for (const o of [input.obstacles[0]!, input.obstacles[4]!])
    o.connectedTo.push("signal")
  return input
}

test("blind dogbones clear off-span pads, traces and vias but reject in-span copper", async () => {
  const rows: { label: string; routed: number; expected: number }[] = []
  const cases = [
    "bottom_pad",
    "bottom_trace",
    "buried_via",
    "inner1_pad",
    "inner1_trace",
    "spanning_via",
    "through_via",
  ] as const
  for (const name of cases) {
    const input = {
      ...fixture(),
      allowBlindAndBuriedVias: name !== "through_via",
    }
    if (
      name === "bottom_pad" ||
      name === "inner1_pad" ||
      name === "through_via"
    )
      input.obstacles.push({
        type: "rect",
        center: { x: 0, y: 0 },
        width: 9,
        height: 5,
        layers: [name === "inner1_pad" ? "inner1" : "bottom"],
        connectedTo: [],
      })
    if (name === "bottom_trace" || name === "inner1_trace")
      input.traces = [
        {
          type: "pcb_trace",
          pcb_trace_id: "fixed_wire",
          connection_name: "fixed",
          route: [
            {
              route_type: "wire",
              x: -4,
              y: 0,
              layer: name === "bottom_trace" ? "bottom" : "inner1",
              width: 4,
            },
            {
              route_type: "wire",
              x: 4,
              y: 0,
              layer: name === "bottom_trace" ? "bottom" : "inner1",
              width: 4,
            },
          ],
        },
      ]
    if (name === "buried_via" || name === "spanning_via")
      input.traces = [
        {
          type: "pcb_trace",
          pcb_trace_id: "fixed_via",
          connection_name: "fixed",
          route: [
            {
              route_type: "wire",
              x: 0,
              y: 0,
              layer: name === "buried_via" ? "inner2" : "inner1",
              width: 0.1,
            },
            {
              route_type: "via",
              x: 0,
              y: 0,
              from_layer: name === "buried_via" ? "inner2" : "inner1",
              to_layer: "bottom",
              ...{
                layers:
                  name === "buried_via"
                    ? ["inner2", "bottom"]
                    : ["inner1", "inner2", "bottom"],
              },
              via_diameter: 9,
              via_hole_diameter: 8,
            },
            { route_type: "wire", x: 0, y: 0, layer: "bottom", width: 0.1 },
          ],
        },
      ]
    const original = JSON.stringify(input)
    let result: ReturnType<typeof routeLocalSignalDogbones> | undefined
    try {
      result = routeLocalSignalDogbones(input, {
        targetLayers: new Map([["signal", "inner1"]]),
        viaDiameter: 0.3,
        viaHoleDiameter: 0.15,
        traceWidth: 0.1,
        clearance: 0.1,
      })
    } catch (error) {
      expect(String(error)).toContain(
        "No collision-free local dogbone assignment",
      )
    }
    expect(JSON.stringify(input)).toBe(original)
    const expected = [
      "inner1_pad",
      "inner1_trace",
      "spanning_via",
      "through_via",
    ].includes(name)
      ? 0
      : 2
    expect(result?.traces.length ?? 0).toBe(expected)
    if (result) {
      expect(
        validateRoutedCopperDrc({
          inputSrj: input,
          routedSrj: { ...input, traces: result.traces },
          clearance: 0.1,
        }).issues,
      ).toEqual([])
      for (const t of result.traces)
        expect(t.route.find((p) => p.route_type === "via")!.layers).toEqual([
          "top",
          "inner1",
        ])
    }
    rows.push({
      label: name.replaceAll("_", " "),
      routed: result?.traces.length ?? 0,
      expected,
    })
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="580"><rect width="920" height="580" fill="#10202c"/><g font-family="Arial" fill="#eff4f7"><text x="28" y="42" font-size="25">Blind escape: check only the layers occupied by copper</text><text x="28" y="80" font-family="monospace" font-size="18">&lt;board layers={4} allowBlindAndBuriedVias /&gt;</text><text x="28" y="110" font-size="17">Signal escapes: top → inner1. Supplied copper is unchanged.</text>${rows.map((r, i) => `<text x="32" y="${165 + i * 49}" font-size="20">${r.label}</text><text x="340" y="${165 + i * 49}" font-size="20">${r.routed}/2 pad escapes</text><text x="590" y="${165 + i * 49}" font-size="18">${r.expected ? "outside via span" : "must remain blocked"}</text>`).join("")}<text x="28" y="548" font-size="17">Bottom copper stays below a blind via. Through vias still intersect it.</text></g></svg>`
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})
