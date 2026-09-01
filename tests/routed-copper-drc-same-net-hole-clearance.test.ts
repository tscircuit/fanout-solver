import { expect, test } from "bun:test"
import type {
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

const traceWidth = 0.1
const viaDiameter = 0.3
const viaHoleDiameter = 0.15
const electricalClearance = 0.05
const mechanicalHoleEdgeClearance = 0.1

function createConnection(name: string, y: number): SimpleRouteConnection {
  return {
    name,
    netConnectionName: "GND",
    pointsToConnect: [
      { x: -1, y, layer: "top" },
      { x: 1, y, layer: "bottom" },
    ],
  }
}

function createViaTrace(params: {
  traceId: string
  connectionName: string
  viaX: number
}): SimplifiedPcbTrace {
  const { traceId, connectionName, viaX } = params
  return {
    type: "pcb_trace",
    pcb_trace_id: traceId,
    connection_name: connectionName,
    route: [
      {
        route_type: "wire",
        x: viaX - 0.1,
        y: 0,
        width: traceWidth,
        layer: "top",
      },
      {
        route_type: "wire",
        x: viaX,
        y: 0,
        width: traceWidth,
        layer: "top",
      },
      {
        route_type: "via",
        x: viaX,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      },
      {
        route_type: "wire",
        x: viaX,
        y: 0,
        width: traceWidth,
        layer: "bottom",
      },
      {
        route_type: "wire",
        x: viaX + 0.1,
        y: 0,
        width: traceWidth,
        layer: "bottom",
      },
    ],
  }
}

function createTwoViaTrace(viaSeparation: number): SimplifiedPcbTrace {
  return {
    type: "pcb_trace",
    pcb_trace_id: "trace-two-vias",
    connection_name: "GND_A",
    route: [
      {
        route_type: "wire",
        x: -0.1,
        y: 0,
        width: traceWidth,
        layer: "top",
      },
      {
        route_type: "wire",
        x: 0,
        y: 0,
        width: traceWidth,
        layer: "top",
      },
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      },
      {
        route_type: "wire",
        x: 0,
        y: 0,
        width: traceWidth,
        layer: "bottom",
      },
      {
        route_type: "wire",
        x: viaSeparation,
        y: 0,
        width: traceWidth,
        layer: "bottom",
      },
      {
        route_type: "via",
        x: viaSeparation,
        y: 0,
        from_layer: "bottom",
        to_layer: "top",
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      },
      {
        route_type: "wire",
        x: viaSeparation,
        y: 0,
        width: traceWidth,
        layer: "top",
      },
      {
        route_type: "wire",
        x: viaSeparation + 0.1,
        y: 0,
        width: traceWidth,
        layer: "top",
      },
    ],
  }
}

const connections = [
  createConnection("GND_A", -1),
  createConnection("GND_B", 1),
]

function createSrj(
  traces: NonNullable<SimpleRouteJson["traces"]> = [],
): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: traceWidth,
    nominalTraceWidth: traceWidth,
    minViaPadDiameter: viaDiameter,
    minViaHoleDiameter: viaHoleDiameter,
    minViaHoleEdgeToViaHoleEdgeClearance: mechanicalHoleEdgeClearance,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    obstacles: [],
    connections,
    traces,
  } as SimpleRouteJson
}

function validateWithViaSeparation(viaSeparation: number) {
  const inputSrj = createSrj()
  const routedSrj = createSrj([
    createViaTrace({
      traceId: "trace-a",
      connectionName: "GND_A",
      viaX: 0,
    }),
    createViaTrace({
      traceId: "trace-b",
      connectionName: "GND_B",
      viaX: viaSeparation,
    }),
  ])
  return validateRoutedCopperDrc({
    inputSrj,
    routedSrj,
    clearance: electricalClearance,
    allowBlindAndBuriedVias: false,
  })
}

test("same-net via pads may overlap when their drilled holes are mechanically clear", () => {
  // The 0.3 mm pads overlap at 0.26 mm, while the 0.15 mm drills retain
  // 0.11 mm edge-to-edge clearance and satisfy the configured 0.10 mm rule.
  expect(validateWithViaSeparation(0.26)).toMatchObject({
    valid: true,
    checkedViaCount: 2,
    issues: [],
  })
})

test("same-net drilled holes must retain mechanical edge clearance", () => {
  // Electrical clearance is only 0.05 mm, so this proves the independent DRC
  // uses the stronger configured 0.10 mm drill-edge rule.
  expect(validateWithViaSeparation(0.24)).toMatchObject({
    valid: false,
    checkedViaCount: 2,
    issues: [
      expect.objectContaining({
        code: "via-hole-clearance",
        traceId: "trace-a",
        connectionName: "GND_A",
        otherTraceId: "trace-b",
        otherConnectionName: "GND_B",
      }),
    ],
  })
})

test("drilled holes within one routed trace must retain mechanical clearance", () => {
  const inputSrj = createSrj()
  const report = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: createSrj([createTwoViaTrace(0.24)]),
    clearance: electricalClearance,
    allowBlindAndBuriedVias: false,
  })

  expect(report).toMatchObject({
    valid: false,
    checkedViaCount: 2,
    issues: [
      expect.objectContaining({
        code: "via-hole-clearance",
        traceId: "trace-two-vias",
        otherTraceId: "trace-two-vias",
      }),
    ],
  })
})
