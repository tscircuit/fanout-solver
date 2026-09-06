import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { fanoutPlansAreClear } from "lib/route-bus"
import { routeViaMinimalWinding } from "lib/route-via-minimal-winding"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("winding preserves the source-layer detour before its first through via", async () => {
  const boundary = { minX: -1, maxX: 6, minY: -2, maxY: 2 }
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: boundary,
    obstacles: [
      {
        type: "rect",
        obstacleId: "source",
        componentId: "U1",
        center: { x: 0, y: 0 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["SIG", "source"],
      },
      {
        type: "rect",
        obstacleId: "blocker",
        center: { x: 2, y: 0 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: [],
      },
    ],
    connections: [
      {
        name: "SIG",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pointId: "source" },
          { x: 6, y: 0, layer: "inner1" },
        ],
      },
    ],
  }
  const bus = prepareFanoutBuses(srj, {
    sharedBoundary: boundary,
    escapeLayers: ["inner1"],
    buses: [
      {
        busId: "DATA",
        connectionNames: ["SIG"],
        sourceComponentId: "U1",
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["inner1"],
      },
    ],
  })[0]!
  bus.exitEdge = "right"
  const sourcePoints = [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 0.2, y: 1.2 },
    { x: 3.8, y: 1.2 },
    { x: 4, y: 1 },
    { x: 4, y: 0.8 },
  ]
  const parameters = {
    srj,
    bus,
    terminals: [
      {
        connection: bus.connections[0]!,
        viaPoint: sourcePoints.at(-1)!,
        exitPoint: { x: 6, y: 0 },
      },
    ],
    targetLayer: "inner1",
    layerNames: ["top", "inner1", "inner2", "bottom"],
    acceptedPlans: [],
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    allowBlindAndBuriedVias: false,
  }
  const straight = routeViaMinimalWinding(parameters)!
  expect(
    fanoutPlansAreClear({
      ...parameters,
      plans: straight,
      sharedBoundary: boundary,
    }),
  ).toBe(false)
  const plans = routeViaMinimalWinding({
    ...parameters,
    sourceEscapePaths: new Map([[0, sourcePoints]]),
  })!
  expect(plans).toHaveLength(1)
  expect(plans[0]!.sourceEscapeSegmentCount).toBe(sourcePoints.length - 1)
  expect(
    fanoutPlansAreClear({ ...parameters, plans, sharedBoundary: boundary }),
  ).toBe(true)
  const route = plans[0]!.trace.route,
    viaIndex = route.findIndex((p) => p.route_type === "via")
  expect(route.filter((p) => p.route_type === "via")).toHaveLength(1)
  expect(
    route
      .slice(0, viaIndex)
      .map((p) => (p.route_type === "wire" ? { x: p.x, y: p.y } : null)),
  ).toEqual(sourcePoints)
  expect(
    route
      .slice(viaIndex + 1)
      .every((p) => p.route_type === "wire" && p.layer === "inner1"),
  ).toBe(true)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames: parameters.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: plans.map((p) => p.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
