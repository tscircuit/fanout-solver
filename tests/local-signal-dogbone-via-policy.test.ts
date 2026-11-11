import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { routeLocalSignalDogbones, validateRoutedCopperDrc } from "lib"

// Policy guard: a logical top -> inner1 transition is still a physical
// through via unless the caller explicitly enables blind/buried vias.
test("local escapes require explicit opt-in to blind and buried vias", () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    obstacles: Array.from({ length: 4 }, (_, i) => ({
      type: "rect" as const,
      componentId: "U1",
      layers: ["top"],
      center: { x: (i % 2) * 0.8 - 0.4, y: Math.floor(i / 2) * 0.8 - 0.4 },
      width: 0.4,
      height: 0.4,
      connectedTo: i === 0 ? ["signal"] : [],
    })),
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: -0.4, y: -0.4, layer: "top" },
          { x: 2, y: 2, layer: "inner1" },
        ],
      },
    ],
  }
  const options = {
    targetLayers: new Map([["signal", "inner1"]]),
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    traceWidth: 0.1,
    clearance: 0.1,
  }
  for (const policy of [
    {},
    { allowBlindAndBuriedVias: false },
    { allowBlindAndBuriedVias: true },
  ]) {
    const configured = { ...options, ...policy }
    const result = routeLocalSignalDogbones(input, configured)
    expect(result.traces).toHaveLength(1)
    expect(
      result.traces[0]!.route.find((p) => p.route_type === "via")!.layers,
    ).toEqual(
      policy.allowBlindAndBuriedVias
        ? ["top", "inner1"]
        : ["top", "inner1", "inner2", "bottom"],
    )
    expect(
      validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: { ...input, traces: result.traces },
        clearance: 0.1,
      }).issues,
    ).toEqual([])

    const blocked = structuredClone(input)
    blocked.obstacles.push({
      type: "rect",
      center: { x: 0, y: 0 },
      width: 5,
      height: 5,
      layers: ["bottom"],
      connectedTo: [],
    })
    const original = JSON.stringify(blocked)
    if (policy.allowBlindAndBuriedVias) {
      const escaped = routeLocalSignalDogbones(blocked, configured)
      expect(escaped.traces).toHaveLength(1)
      expect(
        validateRoutedCopperDrc({
          inputSrj: blocked,
          routedSrj: { ...blocked, traces: escaped.traces },
          clearance: 0.1,
        }).issues,
      ).toEqual([])
    } else {
      expect(() => routeLocalSignalDogbones(blocked, configured)).toThrow(
        "No collision-free local dogbone assignment",
      )
    }
    expect(JSON.stringify(blocked)).toBe(original)
  }
})
