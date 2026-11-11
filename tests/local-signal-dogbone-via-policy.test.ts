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
    const configured = { ...input, ...policy }
    const result = routeLocalSignalDogbones(configured, options)
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
        inputSrj: configured,
        routedSrj: { ...configured, traces: result.traces },
        clearance: 0.1,
      }).issues,
    ).toEqual([])

    const blocked = structuredClone(configured)
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
      const escaped = routeLocalSignalDogbones(blocked, options)
      expect(escaped.traces).toHaveLength(1)
      expect(
        validateRoutedCopperDrc({
          inputSrj: blocked,
          routedSrj: { ...blocked, traces: escaped.traces },
          clearance: 0.1,
        }).issues,
      ).toEqual([])
    } else {
      expect(() => routeLocalSignalDogbones(blocked, options)).toThrow(
        "No collision-free local dogbone assignment",
      )
    }
    expect(JSON.stringify(blocked)).toBe(original)

    // Input via metadata must never opt the board into blind/buried routing.
    // Reject a supplied buried span under the default/false board policy,
    // rather than widening immutable input copper or silently enabling HDI.
    const supplied = {
      ...configured,
      traces: [
        {
          type: "pcb_trace" as const,
          pcb_trace_id: "supplied_buried_via",
          connection_name: "fixed",
          route: [
            {
              route_type: "via" as const,
              x: 2,
              y: -2,
              from_layer: "inner2",
              to_layer: "bottom",
              layers: ["inner2", "bottom"],
              via_diameter: 0.3,
              via_hole_diameter: 0.15,
            },
          ],
        },
      ],
    }
    const before = JSON.stringify(supplied)
    if (policy.allowBlindAndBuriedVias) {
      expect(routeLocalSignalDogbones(supplied, options).traces).toHaveLength(1)
    } else {
      expect(() => routeLocalSignalDogbones(supplied, options)).toThrow(
        "supplied via span requires allowBlindAndBuriedVias=true in the input SRJ",
      )
    }
    expect(JSON.stringify(supplied)).toBe(before)
  }
})
