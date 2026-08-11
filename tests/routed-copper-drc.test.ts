import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

const connections: SimpleRouteConnection[] = [
  {
    name: "A",
    pointsToConnect: [
      { x: 0, y: 0, layer: "top", pointId: "a-source" },
      { x: 3, y: 0, layer: "top", pointId: "a-target" },
    ],
  },
  {
    name: "B",
    pointsToConnect: [
      { x: 1, y: -1, layer: "top", pointId: "b-source" },
      { x: 1, y: 1, layer: "top", pointId: "b-target" },
    ],
  },
]

function obstacle(params: {
  id: string
  x: number
  y: number
  layer: string
  connectionName: string
}): Obstacle {
  return {
    obstacleId: params.id,
    type: "rect",
    center: { x: params.x, y: params.y },
    width: 0.4,
    height: 0.4,
    layers: [params.layer],
    connectedTo: [params.connectionName],
  }
}

function srj(params: {
  obstacles?: Obstacle[]
  traces: SimplifiedPcbTrace[]
}): SimpleRouteJson {
  return {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaHoleDiameter: 0.15,
    minViaPadDiameter: 0.3,
    bounds: { minX: -2, maxX: 4, minY: -2, maxY: 2 },
    obstacles: params.obstacles ?? [],
    connections,
    traces: params.traces,
  }
}

function wireTrace(params: {
  id: string
  connectionName: string
  layer?: string
  points: Array<{ x: number; y: number }>
}): SimplifiedPcbTrace {
  return {
    type: "pcb_trace",
    pcb_trace_id: params.id,
    connection_name: params.connectionName,
    route: params.points.map((point) => ({
      route_type: "wire" as const,
      ...point,
      width: 0.1,
      layer: params.layer ?? "top",
    })),
  }
}

test("rejects a trace crossing a different-net pad on the same layer", () => {
  const input = srj({
    obstacles: [
      obstacle({ id: "b-pad", x: 1, y: 0, layer: "top", connectionName: "B" }),
    ],
    traces: [],
  })
  const routed = {
    ...input,
    traces: [
      wireTrace({
        id: "trace-a",
        connectionName: "A",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      }),
    ],
  }

  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: routed,
      clearance: 0.1,
    }),
  ).toMatchObject({
    valid: false,
    issues: [
      expect.objectContaining({
        code: "trace-obstacle-clearance",
        traceId: "trace-a",
        obstacleId: "b-pad",
        layer: "top",
      }),
    ],
  })
})

test("does not treat visual overlap on a separate layer as a collision", () => {
  const input = srj({
    obstacles: [
      obstacle({ id: "b-pad", x: 1, y: 0, layer: "top", connectionName: "B" }),
    ],
    traces: [],
  })
  const routed = {
    ...input,
    traces: [
      wireTrace({
        id: "trace-a",
        connectionName: "A",
        layer: "inner1",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      }),
    ],
  }

  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: routed,
      clearance: 0.1,
    }),
  ).toMatchObject({ valid: true, issues: [] })
})

test("rejects different-net trace intersections", () => {
  const routed = srj({
    traces: [
      wireTrace({
        id: "trace-a",
        connectionName: "A",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      }),
      wireTrace({
        id: "trace-b",
        connectionName: "B",
        points: [
          { x: 1, y: -1 },
          { x: 1, y: 1 },
        ],
      }),
    ],
  })

  expect(
    validateRoutedCopperDrc({
      inputSrj: routed,
      routedSrj: routed,
      clearance: 0.1,
    }),
  ).toMatchObject({
    valid: false,
    issues: [
      expect.objectContaining({
        code: "different-net-trace-clearance",
        traceId: "trace-a",
        otherTraceId: "trace-b",
      }),
    ],
  })
})

test("rejects a via colliding with a different-net pad anywhere in its span", () => {
  const input = srj({
    obstacles: [
      obstacle({
        id: "b-inner-pad",
        x: 1,
        y: 0,
        layer: "inner1",
        connectionName: "B",
      }),
    ],
    traces: [],
  })
  const viaTrace: SimplifiedPcbTrace = {
    type: "pcb_trace",
    pcb_trace_id: "trace-a",
    connection_name: "A",
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "top" },
      { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "top" },
      {
        route_type: "via",
        x: 1,
        y: 0,
        from_layer: "top",
        to_layer: "inner2",
        via_diameter: 0.3,
      },
      { route_type: "wire", x: 1, y: 0, width: 0.1, layer: "inner2" },
      { route_type: "wire", x: 2, y: 0, width: 0.1, layer: "inner2" },
    ],
  }

  const report = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: [viaTrace] },
    clearance: 0.1,
  })
  expect(report.valid).toBe(false)
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "via-obstacle-clearance",
      obstacleId: "b-inner-pad",
    }),
  )
})

test("rejects virtual through-obstacle transitions as emitted copper", () => {
  const routed = srj({
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "trace-a",
        connection_name: "A",
        route: [
          { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "top" },
          {
            route_type: "through_obstacle",
            start: { x: 0, y: 0 },
            end: { x: 0, y: 0 },
            from_layer: "top",
            to_layer: "inner1",
            width: 0.1,
          },
          { route_type: "wire", x: 0, y: 0, width: 0.1, layer: "inner1" },
        ],
      },
    ],
  })

  expect(
    validateRoutedCopperDrc({
      inputSrj: routed,
      routedSrj: routed,
      clearance: 0.1,
    }),
  ).toMatchObject({
    valid: false,
    issues: [expect.objectContaining({ code: "unsupported-route-point" })],
  })
})

test("allows a trace to leave its own component pad away from the package body", () => {
  const ownPad = {
    ...obstacle({
      id: "a-pad",
      x: 0,
      y: 0.4,
      layer: "top",
      connectionName: "A",
    }),
    componentId: "C1",
  }
  const body: Obstacle = {
    obstacleId: "c1-body",
    type: "rect",
    center: { x: 0, y: 0 },
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: [],
    componentId: "C1",
  }
  const input = srj({ obstacles: [ownPad, body], traces: [] })
  const outwardTrace = wireTrace({
    id: "trace-a",
    connectionName: "A",
    points: [
      { x: 0, y: 0.4 },
      { x: 0, y: 1 },
    ],
  })

  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [outwardTrace] },
      clearance: 0.1,
    }),
  ).toMatchObject({ valid: true, issues: [] })
})

test("rejects a terminal trace directed through its package body", () => {
  const ownPad = {
    ...obstacle({
      id: "a-pad",
      x: 0,
      y: 0.4,
      layer: "top",
      connectionName: "A",
    }),
    componentId: "C1",
  }
  const body: Obstacle = {
    obstacleId: "c1-body",
    type: "rect",
    center: { x: 0, y: 0 },
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: [],
    componentId: "C1",
  }
  const input = srj({ obstacles: [ownPad, body], traces: [] })
  const inwardTrace = wireTrace({
    id: "trace-a",
    connectionName: "A",
    points: [
      { x: 0, y: 0.4 },
      { x: 0, y: -0.5 },
    ],
  })

  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [inwardTrace] },
      clearance: 0.1,
    }),
  ).toMatchObject({
    valid: false,
    issues: [expect.objectContaining({ code: "trace-obstacle-clearance" })],
  })
})
