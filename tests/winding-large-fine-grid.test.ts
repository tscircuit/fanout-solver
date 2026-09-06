import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { fanoutPlansAreClear } from "lib/route-bus"
import { routeViaMinimalWinding } from "lib/route-via-minimal-winding"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("routes a fine winding grid across a 28.65 mm shared boundary", async () => {
  const sharedBoundary = {
    minX: -14.325,
    maxX: 14.325,
    minY: -14.325,
    maxY: 14.325,
  }
  const traceWidth = 0.08128
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: traceWidth,
    bounds: sharedBoundary,
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
        obstacleId: "middle-copper",
        center: { x: 6, y: 0 },
        width: 1,
        height: 4,
        layers: ["inner1"],
        connectedTo: [],
      },
    ],
    connections: [
      {
        name: "SIG",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top", pointId: "source" },
          { x: 14.325, y: 0.4, layer: "inner1" },
        ],
      },
    ],
  }
  const bus = prepareFanoutBuses(srj, {
    sharedBoundary,
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
  // This production-size boundary needs 353 * 353 = 124609 fine-grid nodes.
  const axisNodeCount = Math.floor(28.65 / traceWidth) + 1
  expect(axisNodeCount ** 2).toBe(124609)
  const parameters = {
    srj,
    bus,
    targetLayer: "inner1",
    terminals: [
      {
        connection: bus.connections[0]!,
        viaPoint: { x: 0.4, y: 0.4 },
        exitPoint: { x: 14.325, y: 0.4 },
      },
    ],
    layerNames: ["top", "inner1", "inner2", "bottom"],
    acceptedPlans: [],
    traceWidth,
    clearance: traceWidth,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    gridStep: traceWidth,
    maximumRouteOrderAttempts: 1,
    allowBlindAndBuriedVias: false,
  }
  const plans = routeViaMinimalWinding(parameters)
  expect(plans).toHaveLength(1)
  expect(
    fanoutPlansAreClear({ ...parameters, plans: plans!, sharedBoundary }),
  ).toBe(true)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: plans!,
    layerNames: parameters.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: traceWidth,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const weightedPlans = routeViaMinimalWinding({
    ...parameters,
    heuristicWeight: 2,
  })!
  expect(weightedPlans).toHaveLength(1)
  expect(
    fanoutPlansAreClear({
      ...parameters,
      plans: weightedPlans,
      sharedBoundary,
    }),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: buildOutputSimpleRouteJson({
        inputSrj: srj,
        plans: weightedPlans,
        layerNames: parameters.layerNames,
      }),
      clearance: traceWidth,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  for (const heuristicWeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      routeViaMinimalWinding({ ...parameters, heuristicWeight }),
    ).toThrow("heuristicWeight must be a positive finite number")
  }
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: plans!.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
