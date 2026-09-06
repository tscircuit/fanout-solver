import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeOppositeBottomCrossbarBusSteps } from "lib/route-opposite-bottom-crossbar-bus"
import type { PeripheralSourceEscape } from "lib/route-peripheral-source-escapes"
import type { PreparedBus } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("moves crossbar source ports around an occupied central window", async () => {
  const width = 0.08128,
    clearance = 0.08128,
    viaDiameter = 0.24,
    layerNames = ["top", "inner1", "inner2", "bottom"]
  const boundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    sourceBoundary = {
      minX: -3.2512,
      maxX: 3.2512,
      minY: -3.2512,
      maxY: 3.2512,
    }
  const points = [
      { x: -1.95, y: 0 },
      { x: -1.3, y: 0.65 },
      { x: -0.65, y: 0 },
      { x: 0, y: 0.65 },
    ],
    targetRanks = [2, 0, 3, 1]
  const obstacles: Obstacle[] = points.map((center, index) => ({
    type: "rect",
    shape: "circle",
    center,
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    componentId: "U1",
    obstacleId: `pad-${index}`,
    connectedTo: [`signal-${index}`],
  }))
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: width,
    bounds: boundary,
    obstacles: [
      ...obstacles,
      {
        type: "rect",
        center: { x: -0.25, y: -3.2512 },
        width: 2.5,
        height: 0.1,
        layers: ["inner1"],
        connectedTo: ["occupied-central-ports"],
      } as Obstacle,
    ],
    connections: points.map((point, index) => ({
      name: `signal-${index}`,
      pointsToConnect: [
        { ...point, layer: "top", pointId: `pad-${index}` },
        { x: 5, y: targetRanks[index]!, layer: "inner1" },
      ],
    })),
  }
  const bus: PreparedBus = {
    busId: "DATA",
    componentId: "U1",
    componentObstacles: obstacles,
    componentBounds: { minX: -2.1, maxX: 0.15, minY: -0.15, maxY: 0.8 },
    sharedBoundary: boundary,
    xCoordinates: points.map((point) => point.x),
    yCoordinates: [0, 0.65],
    pitchX: 0.65,
    pitchY: 0.65,
    direction: "up",
    exitEdge: "right",
    preferredExit: "top-right",
    allowedLayers: ["inner2", "inner1"],
    termination: { type: "boundary" },
    maxLengthSkew: 10,
    connections: srj.connections.map((connection, index) => ({
      connection,
      connectionIndex: index,
      sourcePointIndex: 0,
      sourcePoint: connection.pointsToConnect[0]!,
      sourceLayer: "top",
      sourceObstacle: obstacles[index]!,
      targetPoint: connection.pointsToConnect[1]!,
    })),
  }
  const sourceEscapes: PeripheralSourceEscape[] = points.map(
    (point, index) => ({
      connectionIndex: index,
      connectionName: `signal-${index}`,
      segments: [
        {
          start: point,
          end: { x: point.x + 0.325, y: point.y - 0.325 },
          width,
          layer: "top",
        },
      ],
      via: {
        center: { x: point.x + 0.325, y: point.y - 0.325 },
        diameter: viaDiameter,
        holeDiameter: 0.1,
        spanLayers: layerNames,
        fromLayer: "top",
        toLayer: "inner1",
      },
    }),
  )
  const params = {
    srj,
    bus,
    targetLayer: "inner1",
    acceptedPlans: [],
    sourceEscapes,
    sourceBoundary,
    traceWidth: width,
    clearance,
    viaDiameter,
    viaHoleDiameter: 0.1,
    layerNames,
    compactBusTracks: false,
    allowBlindAndBuriedVias: false,
  }
  const steps = routeOppositeBottomCrossbarBusSteps(params)
  let step = steps.next()
  while (!step.done) step = steps.next()
  const plans = step.value
  expect(plans).toHaveLength(4)
  if (!plans) throw new Error("Expected a complete four-lane crossbar")
  for (const plan of plans) {
    expect(plan.additionalVias).toHaveLength(2)
    expect(plan.sourceObstacle).toBe(
      bus.connections[plan.connectionIndex]!.sourceObstacle,
    )
    expect(plan.targetPoint).toEqual(
      bus.connections[plan.connectionIndex]!.targetPoint,
    )
    expect(plan.additionalVias![0]!.center.x).toBeLessThan(-1.5)
    expect(new Set(plan.segments.map((segment) => segment.layer))).toEqual(
      new Set(["top", "inner1", "inner2"]),
    )
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
      preparedBuses: [bus],
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 4, issues: [] })
  const restricted = routeOppositeBottomCrossbarBusSteps({
    ...params,
    bus: { ...bus, routableEscapeLayers: ["inner1"] },
  })
  expect(restricted.next()).toEqual({ done: true, value: null })
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
