import { expect, test } from "bun:test"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("routed copper DRC accepts a via contained in its connected source pad", () => {
  const connection = {
    name: "POWER",
    pointsToConnect: [
      { x: 0, y: 0, layer: "top" as const, pointId: "power-source" },
      { x: 2, y: 0, layer: "top" as const, pointId: "power-target" },
    ],
  }
  const inputSrj: SimpleRouteJson = {
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
    connections: [connection],
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

  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: [trace] },
      clearance: 0.1,
    }),
  ).toMatchObject({ valid: true, issues: [] })
})
