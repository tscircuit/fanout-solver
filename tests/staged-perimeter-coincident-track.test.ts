import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeStagedPerimeterBusSteps } from "lib/route-staged-perimeter-bus"
import type { PeripheralSourceEscape } from "lib/route-peripheral-source-escapes"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("staged lanes continue directly when their boundary tracks coincide with their roofs", async () => {
  const boundary = { minX: -3, maxX: 6, minY: -3, maxY: 4 }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const sources = [
    { x: 0.3, y: -0.3 },
    { x: -1.3, y: -0.3 },
    { x: 0, y: -1 },
  ]
  const viaPoints = [
    { x: 0, y: 0 },
    { x: -1, y: 0 },
    { x: 5.5, y: -1 },
  ]
  // The two inner-layer lanes reach roofs at rowY + padPitch + lane*pitch.
  // Their requested tracks need no descent between the roof and boundary.
  const targetYs = [2, 2.2, -1]
  const srj: SimpleRouteJson = {
    bounds: boundary,
    layerCount: layerNames.length,
    minTraceWidth: 0.1,
    obstacles: sources.map((center, i) => ({
      type: "rect",
      shape: "circle",
      center,
      width: 0.2,
      height: 0.2,
      layers: ["top"],
      componentId: "U1",
      obstacleId: `pad${i}`,
      connectedTo: [`SIG${i}`],
    })),
    connections: sources.map((source, i) => ({
      name: `SIG${i}`,
      pointsToConnect: [
        { ...source, layer: "top", pointId: `pad${i}` },
        { x: boundary.maxX, y: targetYs[i]!, layer: "inner1" },
      ],
    })),
  }
  const connections: PreparedConnection[] = srj.connections.map(
    (connection, i) => ({
      connection,
      connectionIndex: i,
      sourcePoint: connection.pointsToConnect[0]!,
      sourcePointIndex: 0,
      sourceLayer: "top",
      sourceObstacle: srj.obstacles[i]!,
      targetPoint: connection.pointsToConnect[1]!,
    }),
  )
  const bus: PreparedBus = {
    busId: "DATA",
    termination: { type: "boundary" },
    direction: "right",
    exitEdge: "right",
    allowedLayers: ["inner1"],
    connections,
    componentId: "U1",
    componentObstacles: srj.obstacles,
    componentBounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
    sharedBoundary: boundary,
    xCoordinates: [-1.3, 0, 0.3],
    yCoordinates: [-1, -0.3],
    pitchX: 1,
    pitchY: 1,
  }
  const sourceEscapes: PeripheralSourceEscape[] = connections.map(
    (connection, i) => ({
      connectionIndex: i,
      connectionName: connection.connection.name,
      segments: [
        {
          start: connection.sourcePoint,
          end: viaPoints[i]!,
          width: 0.1,
          layer: "top",
        },
      ],
      via: {
        center: viaPoints[i]!,
        diameter: 0.3,
        holeDiameter: 0.15,
        fromLayer: "top",
        toLayer: "inner1",
        spanLayers: layerNames,
      },
    }),
  )
  const steps = routeStagedPerimeterBusSteps({
    srj,
    bus,
    targetLayer: "inner1",
    layerNames,
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    sourceBoundary: { minX: -2, maxX: 2, minY: -2, maxY: 1 },
    sourceEscapes,
    remoteConnectionIndices: new Set([2]),
  })
  let result = steps.next()
  while (!result.done) result = steps.next()
  const plans = result.value
  expect(plans).toHaveLength(3)
  if (!plans) throw new Error("Expected the complete staged bus")
  for (const plan of plans) {
    expect(plan.segments[0]!.start).toMatchObject(
      sources[plan.connectionIndex]!,
    )
    expect(plan.segments.at(-1)!.end).toEqual({
      x: boundary.maxX,
      y: targetYs[plan.connectionIndex]!,
    })
    expect(
      plan.trace.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(1)
    expect(plan.via?.spanLayers).toEqual(layerNames)
    for (const segment of plan.segments) {
      for (const point of [segment.start, segment.end]) {
        expect(Number.isFinite(point.x)).toBe(true)
        expect(Number.isFinite(point.y)).toBe(true)
      }
    }
  }
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
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
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
