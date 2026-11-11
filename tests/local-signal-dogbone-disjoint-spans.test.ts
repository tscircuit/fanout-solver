import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { routeLocalSignalDogbones, validateRoutedCopperDrc } from "lib"

test("opposite-side pad escapes may share XY only with disjoint physical via spans", async () => {
  const input: SimpleRouteJson & { allowBlindAndBuriedVias?: boolean } = {
    allowBlindAndBuriedVias: true,
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    connections: [],
    obstacles: [],
  }
  for (const layer of ["top", "bottom"])
    for (let i = 0; i < 4; i++)
      input.obstacles.push({
        type: "rect",
        componentId: layer,
        layers: [layer],
        center: { x: (i % 2) * 0.8 - 0.4, y: Math.floor(i / 2) * 0.8 - 0.4 },
        width: 0.4,
        height: 0.4,
        connectedTo: i === 0 ? [layer] : [],
      })
  for (const [name, target] of [
    ["top", "inner1"],
    ["bottom", "inner2"],
  ])
    input.connections.push({
      name: name!,
      pointsToConnect: [
        { x: -0.4, y: -0.4, layer: name! },
        { x: 2, y: 2, layer: target! },
      ],
    })
  const options = {
    targetLayers: new Map([
      ["top", "inner1"],
      ["bottom", "inner2"],
    ]),
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
  }
  let result: ReturnType<typeof routeLocalSignalDogbones> | undefined
  let error: unknown
  const original = JSON.stringify(input)
  try {
    result = routeLocalSignalDogbones(input, options)
  } catch (cause) {
    error = cause
  }
  expect(JSON.stringify(input)).toBe(original)
  expect(error).toBeUndefined()
  expect(result?.traces).toHaveLength(2)
  if (result) {
    const vias = result.traces.map(
      (t) => t.route.find((p) => p.route_type === "via")!,
    )
    expect(vias.map((v) => v.layers)).toEqual([
      ["top", "inner1"],
      ["inner2", "bottom"],
    ])
    expect([vias[0]!.x, vias[0]!.y]).toEqual([vias[1]!.x, vias[1]!.y])
    expect(
      validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: { ...input, traces: result.traces },
        clearance: 0.1,
      }).issues,
    ).toEqual([])
    // A longer second via shares inner1 with the first. It must be rejected or
    // assigned a different site; accepting a short is never a valid fallback.
    const overlapping = structuredClone(input)
    overlapping.connections[1]!.pointsToConnect[1] = {
      x: 2,
      y: 2,
      layer: "inner1",
    }
    try {
      const routed = routeLocalSignalDogbones(overlapping, {
        ...options,
        targetLayers: new Map([
          ["top", "inner1"],
          ["bottom", "inner1"],
        ]),
      })
      expect(
        validateRoutedCopperDrc({
          inputSrj: overlapping,
          routedSrj: { ...overlapping, traces: routed.traces },
          clearance: 0.1,
        }).issues,
      ).toEqual([])
    } catch (cause) {
      expect(String(cause)).toContain(
        "Local dogbones collide between components",
      )
    }
  }
  const layers = ["top", "inner1", "inner2", "bottom"],
    colors = ["#ffcf75", "#82cfe9"]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="460"><rect width="920" height="460" fill="#10202c"/><g font-family="Arial" fill="#eff4f7"><text x="28" y="42" font-size="25">Opposite-side blind vias: same position, separate layers</text><text x="28" y="78" font-size="20">${result ? "2/2 local escapes routed; copper clearance passed" : "BEFORE: no escapes; opposite-side pads block the search"}</text>${layers.map((l, i) => `<path d="M90 ${140 + i * 65}H500" stroke="#72858d" stroke-width="2"/><text x="520" y="${146 + i * 65}" font-size="18">${l}</text>`).join("")}${(
    result?.traces ?? []
  )
    .map((t, i) => {
      const v = t.route.find((p) => p.route_type === "via")!
      return `<path d="M290 ${140 + layers.indexOf(v.from_layer) * 65}V${140 + layers.indexOf(v.to_layer) * 65}" stroke="${colors[i]}" stroke-width="18" stroke-linecap="round"/>`
    })
    .join(
      "",
    )}<text x="640" y="160" font-size="18">Layer section</text><text x="640" y="193" font-size="17">Top → inner1</text><text x="640" y="225" font-size="17">Bottom → inner2</text><text x="28" y="395" font-family="monospace" font-size="17">&lt;board layers={4} allowBlindAndBuriedVias /&gt;</text><text x="28" y="430" font-size="17">Emitted via spans are drawn above. Overlapping spans must still clear each other.</text></g></svg>`
  await expect(svg).toMatchSvgSnapshot(import.meta.path)
})
