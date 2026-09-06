import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { fanoutPlansAreClear } from "lib/route-bus"
import { routeViaMinimalWinding } from "lib/route-via-minimal-winding"
import type { RouteViaMinimalWindingParams } from "lib/route-via-minimal-winding"
import type { Bounds, PreparedBus } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

const traceWidth = 0.08128
const clearance = 0.08128
const sharedBoundary: Bounds = {
  minX: -8.627,
  maxX: 8.627,
  minY: -8.627,
  maxY: 8.627,
}
// Interleaved source lanes need the narrow gap between the two central exits.
const fixtures = [
  {
    source: {
      x: -4,
      y: -3,
    },
    via: {
      x: -3.75,
      y: -3.25,
    },
    exit: {
      x: -4.468325454545454,
      y: 8.626999999999999,
    },
  },
  {
    source: {
      x: -4.5,
      y: -2,
    },
    via: {
      x: -4.25,
      y: -2.25,
    },
    exit: {
      x: -7.483685454545454,
      y: 8.626999999999999,
    },
  },
  {
    source: {
      x: -5.5,
      y: -2,
    },
    via: {
      x: -5.25,
      y: -2.25,
    },
    exit: {
      x: -6.981125454545454,
      y: 8.626999999999999,
    },
  },
  {
    source: {
      x: -5.5,
      y: -2.5,
    },
    via: {
      x: -5.25,
      y: -2.75,
    },
    exit: {
      x: -6.478565454545454,
      y: 8.626999999999999,
    },
  },
  {
    source: {
      x: -4,
      y: -2.5,
    },
    via: {
      x: -3.75,
      y: -2.75,
    },
    exit: {
      x: -6.057285454545454,
      y: 8.626999999999999,
    },
  },
  {
    source: {
      x: -3.5,
      y: -3,
    },
    via: {
      x: -3.25,
      y: -3.25,
    },
    exit: {
      x: -4.970885454545455,
      y: 8.626999999999999,
    },
  },
  {
    source: {
      x: -5,
      y: -2.5,
    },
    via: {
      x: -4.75,
      y: -2.75,
    },
    exit: {
      x: -5.894725454545454,
      y: 8.626999999999999,
    },
  },
  {
    source: {
      x: -5.5,
      y: -3.5,
    },
    via: {
      x: -5.25,
      y: -3.75,
    },
    exit: {
      x: -5.473445454545454,
      y: 8.626999999999999,
    },
  },
] as const

test("reserves future boundary exits during a forward winding attempt", async () => {
  const obstacles: Obstacle[] = fixtures.map(({ source }, index) => ({
    type: "rect",
    shape: "circle",
    obstacleId: `pad:${index}`,
    componentId: "component",
    center: source,
    width: 0.254,
    height: 0.254,
    layers: ["top"],
    connectedTo: [`lane:${index}`, `pad:${index}`],
  }))
  const connections = fixtures.map(({ source, exit }, index) => ({
    name: `lane:${index}`,
    pointsToConnect: [
      {
        ...source,
        layer: "top",
        pointId: `pad:${index}`,
        pcb_port_id: `pad:${index}`,
      },
      { ...exit, layer: "bottom" },
    ],
  }))
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    nominalTraceWidth: traceWidth,
    minViaPadDiameter: 0.24,
    minViaHoleDiameter: 0.1,
    minTraceToPadEdgeClearance: clearance,
    minViaEdgeToPadEdgeClearance: clearance,
    defaultObstacleMargin: clearance,
    bounds: sharedBoundary,
    obstacles,
    connections,
  }
  const prepared = connections.map((connection, index) => ({
    connection,
    connectionIndex: index,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: obstacles[index]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const bus: PreparedBus = {
    busId: "WIDE",
    direction: "up",
    exitEdge: "top",
    preferredExit: "top",
    termination: { type: "boundary" },
    connections: prepared,
    componentId: "component",
    componentObstacles: obstacles,
    componentBounds: { minX: -6.752, maxX: 6.752, minY: -6.752, maxY: 6.752 },
    sharedBoundary,
    xCoordinates: Array.from({ length: 23 }, (_, index) => -5.5 + index * 0.5),
    yCoordinates: Array.from({ length: 23 }, (_, index) => -5.5 + index * 0.5),
    pitchX: 0.5,
    pitchY: 0.5,
    routableEscapeLayers: ["bottom"],
  }
  const options: RouteViaMinimalWindingParams = {
    srj: inputSrj,
    bus,
    targetLayer: "bottom",
    acceptedPlans: [],
    terminals: prepared.map((connection, index) => ({
      connection,
      viaPoint: fixtures[index]!.via,
      exitPoint: fixtures[index]!.exit,
    })),
    layerNames: ["top", "bottom"],
    traceWidth,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    maximumRouteOrderAttempts: 1,
    preferTargetDirectedLaneBias: false,
    alignGridToPads: true,
    gridStepDivisor: 2,
  }
  expect(routeViaMinimalWinding(options)).toBeNull()
  const plans = routeViaMinimalWinding({
    ...options,
    reserveTerminalExitPoints: true,
  })
  expect(plans).not.toBeNull()
  if (!plans) throw new Error("Expected every lane to reach its reserved exit")
  expect(plans).toHaveLength(8)
  expect(fanoutPlansAreClear({ ...options, plans, sharedBoundary })).toBe(true)
  for (const [index, plan] of plans.entries()) {
    expect(plan.sourcePoint).toEqual(prepared[index]!.sourcePoint)
    expect(plan.via?.center).toEqual(fixtures[index]!.via)
    expect(plan.exitPoint).toEqual(fixtures[index]!.exit)
    expect(plan.targetLayer).toBe("bottom")
    expect(plan.via?.spanLayers).toEqual(["top", "bottom"])
  }
  const routedSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans,
    layerNames: options.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 8,
    checkedViaCount: 8,
    issues: [],
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...inputSrj,
        connections: [],
        traces: plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
