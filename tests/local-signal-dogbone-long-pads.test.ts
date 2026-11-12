import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { routeLocalSignalDogbones, validateRoutedCopperDrc } from "lib"

// Reduced from the MT8395 board's HDMI connector: 0.5 mm pitch, 2.66 mm
// long signal pads, and mounting pads that introduce a 0.73 mm grid spacing.
test("a long connector pad can escape beyond its edge when grid sites are blocked", async () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.06,
    bounds: { minX: -5, maxX: 5, minY: -8, maxY: 6 },
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 0, y: 4, layer: "inner1" },
        ],
      },
    ],
    obstacles: [
      ...[-0.5, 0, 0.5].map((x) => ({
        type: "rect" as const,
        componentId: "J1",
        center: { x, y: 0 },
        width: 0.3,
        height: 2.66,
        layers: ["top"],
        connectedTo: x === 0 ? ["signal"] : [],
      })),
      ...[-3, 3].flatMap((x) =>
        [-0.73, -6.69].map((y) => ({
          type: "rect" as const,
          componentId: "J1",
          center: { x, y },
          width: 0.8,
          height: 0.8,
          layers: ["top", "inner1", "inner2", "bottom"],
          connectedTo: [],
        })),
      ),
    ],
  }
  const options = {
    targetLayers: new Map([["signal", "inner1"]]),
    viaDiameter: 0.15,
    viaHoleDiameter: 0.075,
    traceWidth: 0.06,
    clearance: 0.06,
  }
  let result: ReturnType<typeof routeLocalSignalDogbones> | undefined
  let error: unknown
  const before = JSON.stringify(input)
  try {
    result = routeLocalSignalDogbones(input, options)
  } catch (cause) {
    error = cause
  }
  expect(JSON.stringify(input)).toBe(before)
  expect(String(error)).toContain("No collision-free local dogbone assignment")
  expect(result).toBeUndefined()

  // Draw only accepted output. The unattached inner-layer destination is outside
  // this pad-detail view: this test concerns the local escape, not a full route.
  const sx = (x: number) => 260 + x * 125
  const sy = (y: number) => 320 - y * 125
  const via = result?.traces[0]?.route.find((p) => p.route_type === "via")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="980" height="620">
<rect width="980" height="620" fill="#122330"/>
<g font-family="Arial" fill="#edf3f7">
<text x="28" y="42" font-size="25">HDMI connector: escape a long signal pad</text>
<text x="28" y="78" font-size="19">${result ? "AFTER: pad connected to a through via; clearance passed" : "BEFORE: no local escape; all grid candidates lie inside pads"}</text>
${input.obstacles
  .slice(0, 3)
  .map(
    (p, i) =>
      `<rect x="${sx(p.center.x - p.width / 2)}" y="${sy(p.height / 2)}" width="${p.width * 125}" height="${p.height * 125}" fill="${i === 1 ? "#b38336" : "#526575"}" stroke="#c8d5dc"/><text x="${sx(p.center.x)}" y="${sy(p.height / 2) - 12}" text-anchor="middle" font-size="16">${i === 1 ? "signal" : "NC"}</text>`,
  )
  .join("")}
${result?.traces.map((t) => `<polyline points="${t.route.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}" fill="none" stroke="#63d9fc" stroke-width="7.5"/>`).join("") ?? ""}
${via ? `<circle cx="${sx(via.x)}" cy="${sy(via.y)}" r="9.375" fill="#63d9fc"/><circle cx="${sx(via.x)}" cy="${sy(via.y)}" r="4.6875" fill="#122330"/>` : ""}
<text x="480" y="165" font-size="19">Actual signal-pad geometry</text>
<text x="480" y="201" font-size="17">Pad: 0.30 × 2.66 mm; pitch: 0.50 mm</text>
<text x="480" y="231" font-size="17">Trace / clearance: 0.06 / 0.06 mm</text>
<text x="480" y="261" font-size="17">Via / drill: 0.15 / 0.075 mm</text>
<text x="480" y="315" font-size="17">Grid midpoints are obstructed.</text>
<text x="480" y="345" font-size="17">A clear site exists beyond the pad end.</text>
<text x="480" y="399" font-size="17">Local pad-to-via escape only</text>
<text x="480" y="429" font-size="17">Default policy: through vias</text>
<text x="28" y="558" font-family="monospace" font-size="17">&lt;board layers={4} allowBlindAndBuriedVias={false}&gt;</text>
<text x="28" y="588" font-family="monospace" font-size="17">  &lt;smtpad pcbX={0} pcbY={0} width={0.3} height={2.66} /&gt;</text>
</g></svg>`
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})
