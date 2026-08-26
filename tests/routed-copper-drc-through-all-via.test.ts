import { expect, test } from "bun:test"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import type { FanoutSimplifiedPcbTrace } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("through-all DRC checks obstacles beyond a via's logical transition", () => {
  const inputSrj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.24,
    bounds: { minX: -2, maxX: 2, minY: -1, maxY: 1 },
    connections: [
      {
        name: "SIGNAL",
        pointsToConnect: [
          { x: -1, y: 0, layer: "top" },
          { x: 1, y: 0, layer: "inner1" },
        ],
      },
      {
        name: "BLOCKER",
        pointsToConnect: [{ x: 0.5, y: 0.5, layer: "bottom" }],
      },
    ],
    obstacles: [
      {
        obstacleId: "bottom-blocker",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 0.2,
        layers: ["bottom"],
        connectedTo: ["BLOCKER"],
      },
    ],
  }
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "signal-trace",
    connection_name: "SIGNAL",
    route: [
      { route_type: "wire", x: -1, y: 0, width: 0.1, layer: "top" },
      { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "top" },
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "inner1",
        via_diameter: 0.24,
      },
      { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "inner1" },
      { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "inner1" },
    ],
  }
  const routedSrj = { ...inputSrj, traces: [trace] }

  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj,
      clearance: 0.1,
      allowBlindAndBuriedVias: true,
    }),
  ).toMatchObject({ valid: true, issues: [] })

  const throughAllReport = validateRoutedCopperDrc({
    inputSrj,
    routedSrj,
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  })
  expect(throughAllReport.valid).toBe(false)
  expect(throughAllReport.issues).toContainEqual(
    expect.objectContaining({
      code: "via-obstacle-clearance",
      traceId: "signal-trace",
    }),
  )

  const traceWithPhysicalLayers: FanoutSimplifiedPcbTrace = {
    ...trace,
    route: trace.route.map((routePoint) =>
      routePoint.route_type === "via"
        ? {
            ...routePoint,
            layers: ["top", "inner1", "inner2", "bottom"],
          }
        : routePoint,
    ),
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: [traceWithPhysicalLayers] },
      clearance: 0.1,
      allowBlindAndBuriedVias: true,
    }).issues,
  ).toContainEqual(expect.objectContaining({ code: "via-obstacle-clearance" }))
})
