import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import type { SimpleRouteJsonWithFanoutPlanes } from "lib/types"
import { validateOriginalEndpointConnectivity } from "lib/validate-original-endpoint-connectivity"
import { srj29FanoutSamples } from "../datasets/srj29"

const sourcePad: Obstacle = {
  obstacleId: "source-pad",
  type: "rect",
  center: { x: 0, y: 0 },
  width: 0.4,
  height: 0.4,
  layers: ["top"],
  connectedTo: ["SIGNAL", "source"],
}
const targetPad: Obstacle = {
  obstacleId: "target-pad",
  type: "rect",
  center: { x: 2, y: 1 },
  width: 0.4,
  height: 0.4,
  layers: ["top"],
  connectedTo: ["SIGNAL", "target"],
}

const inputSrj: SimpleRouteJson = {
  layerCount: 4,
  minTraceWidth: 0.1,
  minViaHoleDiameter: 0.15,
  minViaPadDiameter: 0.3,
  bounds: { minX: -1, maxX: 3, minY: -1, maxY: 2 },
  obstacles: [sourcePad, targetPad],
  connections: [
    {
      name: "SIGNAL",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top", pointId: "source" },
        { x: 2, y: 1, layer: "top", pointId: "target" },
      ],
    },
  ],
}

function routedSrj(trace: SimplifiedPcbTrace): SimpleRouteJson {
  return { ...inputSrj, traces: [trace] }
}

function wireTrace(params: {
  layer: string
  points: Array<{ x: number; y: number }>
}): SimplifiedPcbTrace {
  return {
    type: "pcb_trace",
    pcb_trace_id: "trace",
    connection_name: "SIGNAL",
    route: params.points.map((point) => ({
      route_type: "wire" as const,
      ...point,
      width: 0.1,
      layer: params.layer,
    })),
  }
}

test("boundary contact does not replace original endpoint connectivity", () => {
  const report = validateOriginalEndpointConnectivity({
    inputSrj,
    routedSrj: routedSrj(
      wireTrace({
        layer: "top",
        points: [
          { x: 0, y: 0 },
          { x: 3, y: 0 },
        ],
      }),
    ),
  })

  expect(report).toMatchObject({
    valid: false,
    checkedConnectionCount: 1,
    connectedConnectionCount: 0,
  })
  expect(report.issues).toEqual([
    expect.objectContaining({
      code: "original-endpoints-disconnected",
      connectionName: "SIGNAL",
      disconnectedEndpointIndices: [1],
    }),
  ])
})

test("a trace that physically enters the target pad connects the endpoint", () => {
  const report = validateOriginalEndpointConnectivity({
    inputSrj,
    routedSrj: routedSrj(
      wireTrace({
        layer: "top",
        points: [
          { x: 0, y: 0 },
          { x: 1.9, y: 1 },
          { x: 3, y: 1 },
        ],
      }),
    ),
  })

  expect(report).toMatchObject({
    valid: true,
    checkedConnectionCount: 1,
    connectedConnectionCount: 1,
    checkedEndpointCount: 2,
    connectedEndpointCount: 2,
    issues: [],
  })
})

test("visual overlap on another layer is not endpoint connectivity", () => {
  const report = validateOriginalEndpointConnectivity({
    inputSrj,
    routedSrj: routedSrj(
      wireTrace({
        layer: "inner1",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 1 },
        ],
      }),
    ),
  })

  expect(report.valid).toBe(false)
  expect(report.connectedConnectionCount).toBe(0)
})

test("a via creates a physical path from an inner-layer trace to a target pad", () => {
  const trace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "trace-with-vias",
    connection_name: "SIGNAL",
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "top" },
      { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "top" },
      {
        route_type: "via",
        x: 1,
        y: 0,
        from_layer: "top",
        to_layer: "inner1",
        via_diameter: 0.3,
        via_hole_diameter: 0.15,
      },
      { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "inner1" },
      { route_type: "wire", x: 2, y: 1, width: 0.1, layer: "inner1" },
      {
        route_type: "via",
        x: 2,
        y: 1,
        from_layer: "inner1",
        to_layer: "top",
        via_diameter: 0.3,
        via_hole_diameter: 0.15,
      },
      { route_type: "wire", x: 2, y: 1, width: 0.1, layer: "top" },
    ],
  }
  const report = validateOriginalEndpointConnectivity({
    inputSrj,
    routedSrj: routedSrj(trace),
  })

  expect(report.valid).toBe(true)
  expect(report.connectedConnectionCount).toBe(1)
})

test("same-net dogbones connect through an explicitly declared plane", () => {
  const dogbones: SimplifiedPcbTrace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "source-dogbone",
      connection_name: "SIGNAL",
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "top" },
        { route_type: "wire", x: 0.5, y: 0, width: 0.1, layer: "top" },
        {
          route_type: "via",
          x: 0.5,
          y: 0,
          from_layer: "top",
          to_layer: "inner1",
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        { route_type: "wire", x: 0.5, y: 0, width: 0.1, layer: "inner1" },
      ],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "target-dogbone",
      connection_name: "SIGNAL",
      route: [
        { route_type: "wire", x: 2, y: 1, width: 0.1, layer: "top" },
        { route_type: "wire", x: 1.5, y: 1, width: 0.1, layer: "top" },
        {
          route_type: "via",
          x: 1.5,
          y: 1,
          from_layer: "top",
          to_layer: "inner1",
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        { route_type: "wire", x: 1.5, y: 1, width: 0.1, layer: "inner1" },
      ],
    },
  ]
  const withoutPlane = validateOriginalEndpointConnectivity({
    inputSrj,
    routedSrj: { ...inputSrj, traces: dogbones },
  })
  const withPlane: SimpleRouteJsonWithFanoutPlanes = {
    ...inputSrj,
    traces: dogbones,
    fanoutPlaneConnectivity: [{ connectionName: "SIGNAL", layer: "inner1" }],
  }

  expect(withoutPlane.valid).toBe(false)
  expect(
    validateOriginalEndpointConnectivity({ inputSrj, routedSrj: withPlane }),
  ).toMatchObject({
    valid: true,
    connectedConnectionCount: 1,
    connectedEndpointCount: 2,
  })
})

test("SRJ29 plane dogbones connect power but boundary exits do not connect signals", () => {
  const sample = srj29FanoutSamples.find(({ id }) => id === "sample001")!
  const solver = new FanoutSolver(sample.simpleRouteJson, {
    ...sample.solverOptions,
    completeOriginalEndpoints: false,
  })
  solver.solve()

  expect(solver.getOutput().validation.valid).toBe(true)
  const report = validateOriginalEndpointConnectivity({
    inputSrj: sample.simpleRouteJson,
    routedSrj: solver.getOutput().simpleRouteJson,
  })
  expect(report.valid).toBe(false)
  expect(report.checkedConnectionCount).toBe(21)
  expect(report.connectedConnectionCount).toBeGreaterThan(0)
  expect(
    report.issues.some((issue) =>
      issue.connectionName.startsWith("BUS_SIGNAL"),
    ),
  ).toBe(true)
}, 30_000)
