import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { fanoutPlansAreClear } from "lib/route-bus"
import {
  routeViaMinimalWindingAlternativesSteps,
  type RouteViaMinimalWindingProgress,
} from "lib/route-via-minimal-winding"
import type { PreparedBus } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("conflict repair retains the independent prefix and escapes all five lanes", async () => {
  const boundary = { minX: -2, maxX: 2, minY: -2, maxY: 2 }
  const viaPoints = [
    { x: -0.8, y: -0.6 },
    { x: -0.4, y: -1.2 },
    { x: 0.6, y: 1 },
    { x: -1.2, y: 0.6 },
    { x: -1.2, y: -0.8 },
  ]
  const pads: Obstacle[] = viaPoints.map((via, index) => ({
    type: "rect",
    center: {
      x: via.x + (index === 0 ? 0.2 : -0.2),
      y: via.y + (index === 0 ? 0.2 : -0.2),
    },
    width: 0.1,
    height: 0.1,
    layers: ["top"],
    connectedTo: [`N${index}`],
    componentId: "U1",
  }))
  const connections = viaPoints.map((_, index) => ({
    name: `N${index}`,
    pointsToConnect: [
      { ...pads[index]!.center, layer: "top" },
      { x: -1.6 + index * 0.8, y: 2, layer: "bottom" },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: boundary,
    obstacles: pads,
    connections,
  }
  const prepared = connections.map((connection, index) => ({
    connection,
    connectionIndex: index,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: pads[index]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const bus: PreparedBus = {
    busId: "BUS",
    direction: "up",
    exitEdge: "top",
    preferredExit: "top",
    termination: { type: "boundary" },
    connections: prepared,
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: boundary,
    sharedBoundary: boundary,
    xCoordinates: [-1, 0, 1],
    yCoordinates: [-1, 0, 1],
    pitchX: 1,
    pitchY: 1,
    routableEscapeLayers: ["bottom"],
  }
  const params = {
    srj,
    bus,
    targetLayer: "bottom",
    acceptedPlans: [],
    terminals: prepared.map((connection, index) => ({
      connection,
      viaPoint: viaPoints[index]!,
      exitPoint: connection.targetPoint,
    })),
    layerNames: ["top", "bottom"],
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.2,
    viaHoleDiameter: 0.1,
    maximumRouteOrderAttempts: 18,
    maximumSearchStates: 10_000,
    adaptiveRouteOrder: true,
  }
  const steps = routeViaMinimalWindingAlternativesSteps(params)
  const completions: RouteViaMinimalWindingProgress[] = []
  let result = steps.next()
  while (!result.done) {
    if (result.value.connectionComplete) completions.push(result.value)
    result = steps.next()
  }
  const plans = result.value[0] ?? []
  // Capture the current geometry even when the bus cannot escape.
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
  expect(result.value).toHaveLength(1)
  expect(plans).toHaveLength(5)
  // Promoting every blocked lane to the front fails within this budget.
  // The learned order preserves N1 ahead of N3/N4/N0/N2 on the successful retry.
  const finalAttempt = completions.at(-1)!.routeOrderAttempt
  expect(finalAttempt).toBeLessThanOrEqual(18)
  const finalEvents = completions.filter(
    (e) => e.routeOrderAttempt === finalAttempt,
  )
  expect(finalEvents.map((e) => e.connectionName)).toEqual([
    "N1",
    "N3",
    "N4",
    "N0",
    "N2",
  ])
  expect(finalEvents.slice(0, 2).map((e) => e.expandedStateCount)).toEqual([
    0, 0,
  ])
  expect(
    fanoutPlansAreClear({ ...params, plans, sharedBoundary: boundary }),
  ).toBe(true)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames: params.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 5,
    checkedViaCount: 5,
    issues: [],
  })
})
