import { expect, test } from "bun:test"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("routed copper DRC requires an explicit via-in-pad opt-in", () => {
  const inputSrj: SimpleRouteJson & { allowViaInPad?: boolean } = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaHoleDiameter: 0.12,
    minViaPadDiameter: 0.24,
    bounds: { minX: -1, maxX: 3, minY: -1, maxY: 1 },
    obstacles: [
      {
        obstacleId: "power-source-pad",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.32,
        height: 0.32,
        layers: ["top"],
        connectedTo: ["POWER", "power-source"],
      },
    ],
    connections: [
      {
        name: "POWER",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pointId: "power-source" },
          { x: 2, y: 0, layer: "top", pointId: "power-target" },
        ],
      },
    ],
    traces: [],
  }
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "power-via-in-pad",
    connection_name: "POWER",
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "top" },
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "inner1",
        via_diameter: 0.24,
        via_hole_diameter: 0.12,
      },
      { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "inner1" },
      { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "inner1" },
    ],
  }

  const withoutOptIn = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: { ...inputSrj, traces: [trace] },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  })
  expect(withoutOptIn.valid).toBe(false)
  expect(withoutOptIn.issues).toEqual([
    expect.objectContaining({ code: "via-at-endpoint" }),
  ])

  const withOptInSrj = { ...inputSrj, allowViaInPad: true }
  expect(
    validateRoutedCopperDrc({
      inputSrj: withOptInSrj,
      routedSrj: { ...withOptInSrj, traces: [trace] },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
})
