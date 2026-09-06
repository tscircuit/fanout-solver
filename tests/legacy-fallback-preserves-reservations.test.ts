import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus, type RouteBusParams } from "lib/route-bus"
import type { PreparedBus } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("legacy fallback cannot abandon fixed sources or hard reservations when winding fails", async () => {
  const boundary = { minX: -1, maxX: 4, minY: -1, maxY: 1 }
  const layerNames = ["top", "bottom"]
  const source = { x: 0, y: 0, layer: "top", pointId: "pad" }
  const target = { x: 4, y: 0, layer: "bottom" }
  const pad = {
    obstacleId: "pad",
    componentId: "U1",
    type: "rect" as const,
    shape: "circle" as const,
    center: { x: 0, y: 0 },
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    connectedTo: ["SIGNAL"],
  }
  const connection = { name: "SIGNAL", pointsToConnect: [source, target] }
  const srj: SimpleRouteJson = {
    bounds: boundary,
    layerCount: 2,
    minTraceWidth: 0.1,
    obstacles: [
      pad,
      {
        obstacleId: "unrelated-pad",
        type: "rect",
        center: { x: 2, y: 0.4 },
        width: 0.4,
        height: 0.4,
        layers: layerNames,
        connectedTo: [],
      },
    ],
    connections: [connection],
  }
  const bus: PreparedBus = {
    busId: "SIGNAL",
    componentId: "U1",
    componentObstacles: [pad],
    componentBounds: { minX: -0.15, maxX: 0.15, minY: -0.15, maxY: 0.15 },
    sharedBoundary: boundary,
    xCoordinates: [0],
    yCoordinates: [0],
    pitchX: 0.65,
    pitchY: 0.65,
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    connections: [
      {
        connection,
        connectionIndex: 0,
        sourcePointIndex: 0,
        sourcePoint: source,
        sourceLayer: "top",
        sourceObstacle: pad,
        targetPoint: target,
        exitTargetPoint: target,
        hasExplicitLayeredExitTarget: false,
      },
    ],
  }
  const params: RouteBusParams = {
    srj,
    bus,
    targetLayer: "bottom",
    acceptedPlans: [],
    layerNames,
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    compactBusTracks: true,
    allowBlindAndBuriedVias: false,
  }
  const original = structuredClone({ srj, bus })
  const unconstrained = routeBus(params)
  expect(unconstrained).toHaveLength(1)
  if (!unconstrained?.[0]?.via)
    throw new Error("Expected the ordinary legacy escape")
  const sourcePath = [
    { x: 0, y: 0 },
    { x: 0.6, y: 0 },
    { x: 1, y: 0.4 },
    { x: 2, y: 0.4 },
  ]
  const fixed = new Map([[0, sourcePath.at(-1)!]])
  const sourceEscapePaths = new Map([[0, sourcePath]])
  // The requested fixed barrel is inside unrelated copper. A different local
  // dogbone would look valid by itself while silently discarding this request.
  expect(
    routeBus({ ...params, fixedViaPointsByConnectionIndex: fixed }),
  ).toBeNull()
  expect(routeBus({ ...params, sourceEscapePaths })).toBeNull()
  expect(
    routeBus({
      ...params,
      fixedViaPointsByConnectionIndex: fixed,
      sourceEscapePaths,
    }),
  ).toBeNull()
  expect(
    routeBus({
      ...params,
      reservedVias: [
        {
          connectionName: "FUTURE",
          via: unconstrained[0].via,
        },
      ],
    }),
  ).toBeNull()
  expect({ srj, bus }).toEqual(original)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: unconstrained,
    layerNames,
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
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
