import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus, type RouteBusParams } from "lib/route-bus"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("fixed singleton source routes around copper to its captured boundary endpoint without layered guidance", async () => {
  const boundary = { minX: -3, maxX: 5, minY: -3, maxY: 3 }
  const layerNames = ["top", "inner1", "bottom"]
  const pad = {
    obstacleId: "reset-pad",
    componentId: "U1",
    type: "rect" as const,
    shape: "circle" as const,
    center: { x: 0, y: 0 },
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    connectedTo: ["RESET"],
  }
  const connection = {
    name: "RESET",
    source_trace_id: "source-trace-reset",
    pointsToConnect: [
      { x: 0, y: 0, layer: "top", pointId: "reset-pad" },
      { x: 4.9999, y: 1.2, layer: "inner1", pointId: "captured-breakout" },
    ],
  }
  const srj: SimpleRouteJson = {
    bounds: boundary,
    layerCount: 3,
    minTraceWidth: 0.1,
    obstacles: [
      pad,
      {
        obstacleId: "inner-copper",
        type: "rect",
        center: { x: 2, y: 0.8 },
        width: 0.4,
        height: 1.6,
        layers: ["inner1"],
        connectedTo: [],
      },
    ],
    connections: [connection],
  }
  const prepared: PreparedConnection = {
    connection,
    connectionIndex: 0,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: pad,
    targetPoint: connection.pointsToConnect[1]!,
    exitTargetPoint: { x: 4.9999, y: 1.2 },
    hasExplicitLayeredExitTarget: false,
  }
  const bus: PreparedBus = {
    busId: "RESET",
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
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    termination: { type: "boundary" },
    connections: [prepared],
  }
  const params: RouteBusParams = {
    srj,
    bus,
    targetLayer: "inner1",
    acceptedPlans: [],
    layerNames,
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    compactBusTracks: true,
    allowBlindAndBuriedVias: false,
    viaMinimalOnly: true,
    alignWindingGridToPads: true,
  }
  expect(routeBus(params)).toBeNull()
  const original = structuredClone({ srj, bus })
  const sourcePath = [
    { x: 0, y: 0 },
    { x: 0.4, y: 0 },
    { x: 0.6, y: 0.2 },
  ]
  const plans = routeBus({
    ...params,
    fixedViaPointsByConnectionIndex: new Map([[0, sourcePath[2]!]]),
    sourceEscapePaths: new Map([[0, sourcePath]]),
  })
  expect(plans).toHaveLength(1)
  if (!plans)
    throw new Error("Expected the fixed RESET source to reach its boundary")
  const plan = plans[0]!
  expect(plan.exitPoint).toEqual({ x: 5, y: 1.2 })
  expect(plan.targetLayer).toBe("inner1")
  expect(plan.direction).toBe("right")
  expect(plan.targetPoint).toEqual(prepared.targetPoint)
  expect(plan.sourcePoint).toEqual(prepared.sourcePoint)
  expect(plan.via?.center).toEqual(sourcePath[2]!)
  expect(plan.via?.spanLayers).toEqual(layerNames)
  expect(plan.additionalVias ?? []).toHaveLength(0)
  expect(plan.segments.slice(0, 2)).toEqual(
    sourcePath.slice(1).map((end, i) => ({
      start: sourcePath[i]!,
      end,
      layer: "top",
      width: 0.1,
    })),
  )
  expect({ srj, bus }).toEqual(original)
  expect(prepared.hasExplicitLayeredExitTarget).toBe(false)
  expect(prepared.exitTargetPoint).not.toHaveProperty("layer")
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(output.connections[0]!.pointsToConnect[1]).toEqual(
    prepared.targetPoint,
  )
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: [bus],
      sharedBoundary: boundary,
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 1,
    brokenOutConnectionCount: 1,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 1, issues: [] })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
