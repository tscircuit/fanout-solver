import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { routeLocalSignalDogbones, validateRoutedCopperDrc } from "lib"

// USB ESD package from the MT8395 SBC, translated to the origin. A 0.95 mm
// inferred grid produces a 0.475 mm escape even though a legal site is closer.
test("rectangular USB pads retain unnecessarily long midpoint escapes", async () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.06,
    bounds: { minX: -3, maxX: 5, minY: -3, maxY: 4 },
    connections: [
      {
        name: "USB_N",
        pointsToConnect: [
          { x: 0.95, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "inner1" },
        ],
      },
    ],
    obstacles: [-0.95, 0, 0.95].flatMap((x) =>
      [0, 1.9].map((y) => ({
        type: "rect" as const,
        componentId: "U_ESD",
        center: { x, y },
        width: 0.532,
        height: 1.072,
        layers: ["top"],
        connectedTo: x === 0.95 && y === 0 ? ["USB_N"] : [],
      })),
    ),
  }
  const options = {
    targetLayers: new Map([["USB_N", "inner1"]]),
    viaDiameter: 0.15,
    viaHoleDiameter: 0.075,
    traceWidth: 0.06,
    clearance: 0.06,
  }
  const before = JSON.stringify(input)
  const result = routeLocalSignalDogbones(input, options)
  const via = result.traces[0]!.route.find((p) => p.route_type === "via")!
  expect(JSON.stringify(input)).toBe(before)
  expect(result.traces).toHaveLength(1)
  expect(via.x).toBeCloseTo(1.425, 8)
  expect(via.y).toBe(0)
  for (const policy of [undefined, false, true]) {
    const configured = { ...input, allowBlindAndBuriedVias: policy }
    const routed = routeLocalSignalDogbones(configured, options)
    const barrel = routed.traces[0]!.route.find((p) => p.route_type === "via")!
    expect(barrel.layers).toEqual(
      policy ? ["top", "inner1"] : ["top", "inner1", "inner2", "bottom"],
    )
    expect(
      validateRoutedCopperDrc({
        inputSrj: configured,
        routedSrj: { ...configured, traces: routed.traces },
        clearance: 0.06,
      }).issues,
    ).toEqual([])
  }
  const escape = via.x - 0.95
  const sx = (x: number) => 70 + (x + 1.3) * 180
  const sy = (y: number) => 580 - y * 180
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="850">
<rect width="1000" height="850" fill="#122330"/>
<g font-family="Arial" fill="#edf3f7">
<text x="28" y="40" font-size="25">USB ESD pad: shorter legal fanout</text>
<text x="28" y="77" font-size="19">${escape > 0.45 ? "BEFORE: distant grid midpoint" : "AFTER: clear pad-edge site"}; escape ${escape.toFixed(3)} mm</text>
${input.obstacles.map((o) => `<rect x="${sx(o.center.x - o.width / 2)}" y="${sy(o.center.y + o.height / 2)}" width="${o.width * 180}" height="${o.height * 180}" fill="${o.connectedTo.length ? "#b38336" : "#526575"}" stroke="#c8d5dc"/>`).join("")}
<path d="M${sx(0.95)} ${sy(0)}H${sx(via.x)}" fill="none" stroke="#63d9fc" stroke-width="9"/>
<ellipse cx="${sx(via.x)}" cy="${sy(via.y)}" rx="13.5" ry="13.5" fill="#63d9fc"/>
<ellipse cx="${sx(via.x)}" cy="${sy(via.y)}" rx="6.75" ry="6.75" fill="#122330"/>
<text x="740" y="185" font-size="18">Pad: 0.532 × 1.072 mm</text>
<text x="740" y="220" font-size="18">Via: 0.15 mm</text>
<text x="740" y="255" font-size="18">Clearance: 0.06 mm</text>
<text x="740" y="315" font-size="18">Actual accepted escape</text>
<text x="740" y="350" font-size="18">Through via by default</text>
<text x="28" y="725" font-size="17">Local escape only. End-to-end routing is outside this fixture.</text>
<text x="28" y="780" font-family="monospace" font-size="17">&lt;board layers={4} allowBlindAndBuriedVias={false}&gt;</text>
<text x="28" y="815" font-family="monospace" font-size="17">  &lt;smtpad pcbX={0.95} pcbY={0} width={0.532} height={1.072} /&gt;</text>
</g></svg>`
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})
