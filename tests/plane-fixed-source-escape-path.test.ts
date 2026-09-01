import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { type RouteBusParams, routeBus } from "lib/route-bus"
import type { FanoutBusSpec, Point2D } from "lib/types"

const connectionName = "VSS_A1"

function createRouteContext(): {
  connectionIndex: number
  routeParams: Omit<RouteBusParams, "fixedSourceEscapePathsByConnectionIndex">
} {
  const buses: FanoutBusSpec[] = [
    {
      busId: "ground",
      connectionNames: [connectionName],
      sourceComponentId: "bga",
      direction: "right",
      termination: { type: "plane", layer: "inner1" },
    },
  ]
  const srj: SimpleRouteJson = {
    layerCount: 8,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    connections: [
      {
        name: connectionName,
        pointsToConnect: [
          {
            x: -0.4,
            y: 0.4,
            layer: "top",
            pointId: "bga:A1",
            pcb_port_id: "bga:A1",
          },
        ],
      },
    ],
    obstacles: [
      [-0.4, 0.4],
      [0.4, 0.4],
      [-0.4, -0.4],
      [0.4, -0.4],
    ].map(([x, y], index) => ({
      obstacleId: `pad-${index}`,
      componentId: "bga",
      type: "rect" as const,
      shape: "circle" as const,
      center: { x, y },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      connectedTo: index === 0 ? [connectionName, "bga:A1"] : [],
    })),
    buses: buses as NonNullable<SimpleRouteJson["buses"]>,
  }
  const solver = new FanoutSolver(srj, {
    buses,
    sharedBoundary: { minX: -1.5, maxX: 1.5, minY: -1.5, maxY: 1.5 },
    escapeLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
  })
  const bus = solver.preparedBuses[0]!
  return {
    connectionIndex: bus.connections[0]!.connectionIndex,
    routeParams: {
      srj,
      bus,
      targetLayer: "inner1",
      acceptedPlans: [],
      layerNames: [
        "top",
        "inner1",
        "inner2",
        "inner3",
        "inner4",
        "inner5",
        "inner6",
        "bottom",
      ],
      traceWidth: 0.1,
      viaDiameter: 0.25,
      viaHoleDiameter: 0.15,
      clearance: 0.1,
      compactBusTracks: false,
      allowBlindAndBuriedVias: false,
    },
  }
}

test("a fixed multi-segment plane escape preserves every vertex and uses one via", () => {
  const { connectionIndex, routeParams } = createRouteContext()
  const sourceEscapePath: Point2D[] = [
    { x: -0.4, y: 0.4 },
    { x: -0.15, y: 0.65 },
    { x: -0.15, y: 1.15 },
  ]

  const plans = routeBus({
    ...routeParams,
    fixedSourceEscapePathsByConnectionIndex: new Map([
      [connectionIndex, sourceEscapePath],
    ]),
  })

  expect(plans).toHaveLength(1)
  const plan = plans![0]!
  expect(
    plan.trace.route.flatMap((point) =>
      point.route_type === "wire" && point.layer === "top"
        ? [{ x: point.x, y: point.y }]
        : [],
    ),
  ).toEqual(sourceEscapePath)
  expect(
    plan.segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      layer: segment.layer,
    })),
  ).toEqual([
    {
      start: sourceEscapePath[0],
      end: sourceEscapePath[1],
      layer: "top",
    },
    {
      start: sourceEscapePath[1],
      end: sourceEscapePath[2],
      layer: "top",
    },
  ])
  expect(plan.via).toMatchObject({
    center: sourceEscapePath.at(-1),
    fromLayer: "top",
    toLayer: "inner1",
    diameter: 0.25,
    holeDiameter: 0.15,
  })
  expect(plan.additionalVias ?? []).toHaveLength(0)
  expect(
    plan.trace.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(1)
})

test("a fixed plane escape must start at the prepared source", () => {
  const { connectionIndex, routeParams } = createRouteContext()
  expect(() =>
    routeBus({
      ...routeParams,
      fixedSourceEscapePathsByConnectionIndex: new Map([
        [
          connectionIndex,
          [
            { x: -0.3, y: 0.4 },
            { x: -0.15, y: 0.65 },
            { x: -0.15, y: 1.15 },
          ],
        ],
      ]),
    }),
  ).toThrow(
    `FanoutSolver: source escape path for "${connectionName}" must run from its source point to its via`,
  )
})

test("a fixed plane escape and separately fixed via must share an endpoint", () => {
  const { connectionIndex, routeParams } = createRouteContext()
  expect(() =>
    routeBus({
      ...routeParams,
      fixedViaPointsByConnectionIndex: new Map([
        [connectionIndex, { x: -0.15, y: 1.05 }],
      ]),
      fixedSourceEscapePathsByConnectionIndex: new Map([
        [
          connectionIndex,
          [
            { x: -0.4, y: 0.4 },
            { x: -0.15, y: 0.65 },
            { x: -0.15, y: 1.15 },
          ],
        ],
      ]),
    }),
  ).toThrow(
    `FanoutSolver: fixed source escape path for "${connectionName}" must end at its fixed via`,
  )
})

test("fixed plane static-clearance caching is scoped to the complete path geometry", () => {
  const { connectionIndex, routeParams } = createRouteContext()
  const clearPath: Point2D[] = [
    { x: -0.4, y: 0.4 },
    { x: -0.15, y: 0.65 },
    { x: -0.15, y: 1.15 },
  ]
  const blockedPath: Point2D[] = [
    { x: -0.4, y: 0.4 },
    { x: 0.4, y: 0.4 },
  ]
  const routeWithPath = (
    path: readonly Point2D[],
    staticClearanceCache: Map<string, boolean>,
  ) =>
    routeBus({
      ...routeParams,
      staticClearanceCache,
      fixedSourceEscapePathsByConnectionIndex: new Map([
        [connectionIndex, path],
      ]),
    })

  const falseThenTrueCache = new Map<string, boolean>()
  expect(routeWithPath(blockedPath, falseThenTrueCache)).toBeNull()
  expect(routeWithPath(clearPath, falseThenTrueCache)).toHaveLength(1)

  const trueThenFalseCache = new Map<string, boolean>()
  expect(routeWithPath(clearPath, trueThenFalseCache)).toHaveLength(1)
  expect(routeWithPath(blockedPath, trueThenFalseCache)).toBeNull()
})
