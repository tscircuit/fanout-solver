import { expect, test } from "bun:test"
import "bun-match-svg"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { plansPreserveSourcesAndCorners } from "../lib/plans-preserve-sources-and-corners"
import { fanoutPlansAreClear } from "../lib/route-bus"
import { routeSingletonWithLocalPlaneRecoverySteps } from "../lib/route-singleton-with-local-plane-recovery"
import { chamferSplitPerimeter } from "../lib/route-split-perimeter-source-escapes"
import { buildViaMinimalWindingPlan } from "../lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "../lib/types"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

test("opens an enclosed singleton by rerouting one neighboring lane with fixed sources", async () => {
  const width = 0.08128
  const clearance = 0.08128
  const boundary = { minX: -3.5, maxX: 3.5, minY: -3.5, maxY: 3.5 }
  const layerNames = ["top", "bottom"]
  const points = [
    { x: -3, y: 1.05 },
    { x: -0.3, y: 0.3 },
  ]
  const vias = [
    { x: -3.3, y: 0.75 },
    { x: 0, y: 0 },
  ]
  const names = ["CONTROL", "RESET"]
  const obstacles: Obstacle[] = points.map((center, i) => ({
    type: "rect",
    shape: "circle",
    width: 0.2,
    height: 0.2,
    center,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [names[i]!],
  }))
  const connections = points.map((point, i) => ({
    name: names[i]!,
    pointsToConnect: [
      { ...point, layer: "top", pointId: `source-${i}` },
      { x: vias[i]!.x, y: -5, layer: "bottom", pointId: `target-${i}` },
    ],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: width,
    bounds: { ...boundary, minY: -5.5 },
    obstacles,
    connections,
  }
  const prepared: PreparedConnection[] = connections.map((connection, i) => ({
    connection,
    connectionIndex: i,
    sourcePointIndex: 0,
    sourcePoint: connection.pointsToConnect[0]!,
    sourceLayer: "top",
    sourceObstacle: obstacles[i]!,
    targetPoint: connection.pointsToConnect[1]!,
  }))
  const buses: PreparedBus[] = prepared.map((connection, i) => ({
    busId: names[i]!,
    componentId: "U1",
    componentObstacles: obstacles,
    componentBounds: { minX: -3.1, maxX: -0.2, minY: 0.2, maxY: 1.15 },
    sharedBoundary: boundary,
    xCoordinates: [-3, -0.3],
    yCoordinates: [0.3, 1.05],
    pitchX: 1,
    pitchY: 1,
    termination: { type: "boundary" },
    connections: [connection],
    direction: "down",
    exitEdge: "bottom",
    preferredExit: "bottom",
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
  }))
  const base = {
    srj,
    traceWidth: width,
    clearance,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    targetLayer: "bottom",
    compactBusTracks: false,
  }
  const sourceEscapes = prepared.map((connection, i) => ({
    connectionIndex: i,
    connectionName: connection.connection.name,
    segments: [
      { start: connection.sourcePoint, end: vias[i]!, layer: "top", width },
    ],
    via: {
      center: vias[i]!,
      diameter: 0.24,
      holeDiameter: 0.1,
      fromLayer: "top",
      toLayer: "bottom",
      spanLayers: layerNames,
    },
  }))
  const blocker = buildViaMinimalWindingPlan({
    ...base,
    bus: buses[0]!,
    terminal: {
      connection: prepared[0]!,
      viaPoint: vias[0]!,
      exitPoint: { x: -3.3, y: boundary.minY },
    },
    sourceEscapePoints: [prepared[0]!.sourcePoint, vias[0]!],
    targetLayerPoints: chamferSplitPerimeter(
      [
        vias[0]!,
        { x: 0.5, y: 0.75 },
        { x: 0.5, y: -0.75 },
        { x: -3.3, y: -0.75 },
        { x: -3.3, y: boundary.minY },
      ],
      width,
    ),
  })
  const stub = buildViaMinimalWindingPlan({
    ...base,
    bus: buses[1]!,
    terminal: {
      connection: prepared[1]!,
      viaPoint: vias[1]!,
      exitPoint: vias[1]!,
    },
    sourceEscapePoints: [prepared[1]!.sourcePoint, vias[1]!],
    targetLayerPoints: [vias[1]!, vias[1]!],
  })
  stub.termination = { type: "plane", layer: "bottom" }
  expect(
    fanoutPlansAreClear({
      ...base,
      sharedBoundary: boundary,
      plans: [blocker, stub],
    }),
  ).toBe(true)
  const params = {
    ...base,
    bus: buses[1]!,
    preparedBuses: buses,
    sourceEscapes,
    acceptedPlans: [blocker, stub],
  }
  const before = JSON.stringify(params)
  const g = routeSingletonWithLocalPlaneRecoverySteps(params)
  let r = g.next()
  while (!r.done) r = g.next()
  expect(r.value).not.toBeNull()
  if (!r.value) throw Error("Expected local singleton recovery")
  expect(JSON.stringify(params)).toBe(before)
  const result = r.value
  const plans = result.plans
  expect(plans).toHaveLength(2)
  expect(result.sourceEscapes).toEqual(sourceEscapes)
  expect(plans.find((p) => p.connectionIndex === 0)!.exitPoint).toEqual(
    blocker.exitPoint,
  )
  expect(plans.find((p) => p.connectionIndex === 0)!.segments).not.toEqual(
    blocker.segments,
  )
  expect(
    plansPreserveSourcesAndCorners({
      plans,
      preparedBuses: buses,
      sourceEscapes: result.sourceEscapes,
    }),
  ).toBe(true)
  for (const plan of plans) {
    expect(plan.busId).toBe(names[plan.connectionIndex]!)
    expect(plan.sourceObstacle).toBe(obstacles[plan.connectionIndex]!)
    expect(plan.via).toEqual(sourceEscapes[plan.connectionIndex]!.via)
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj,
      plans,
      preparedBuses: buses,
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: outputSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  const beforeSvg = getSvgFromGraphicsObject(
    visualizeSimpleRouteJson({
      ...srj,
      bounds: boundary,
      traces: [blocker.trace, stub.trace],
    }),
  ).replace("<svg ", '<svg x="0" y="32" ')
  const afterSvg = getSvgFromGraphicsObject(
    visualizeSimpleRouteJson({
      ...srj,
      bounds: boundary,
      traces: plans.map((p) => p.trace),
    }),
  ).replace("<svg ", '<svg x="640" y="32" ')
  await expect(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="672" viewBox="0 0 1280 672"><rect width="1280" height="672" fill="white"/><text x="20" y="24" font-family="sans-serif" font-size="18">Before: enclosed source</text><text x="660" y="24" font-family="sans-serif" font-size="18">After: both routes reach the bottom edge</text>${beforeSvg}${afterSvg}</svg>`,
  ).toMatchSvgSnapshot(import.meta.path)
})
