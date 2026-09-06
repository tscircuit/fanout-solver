import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeReservedSourceBusesSteps } from "lib/route-reserved-source-buses"
import { reflectFanoutX } from "lib/reflect-fanout-x"
import type { PeripheralSourceEscape } from "lib/route-peripheral-source-escapes"
import type { PreparedBus } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("mirrors a lower-corner crossbar while retaining pad identity and target metadata", async () => {
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
    obstacles,
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
    direction: "down",
    exitEdge: "right",
    preferredExit: "bottom-right",
    allowedLayers: ["top", "inner1"],
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
  const original = reflectFanoutX({
    ...params,
    buses: [bus],
    initialPlans: [],
    targetLayerByBusId: new Map([[bus.busId, "inner1"]]),
  })
  expect(original.buses[0]!.connections[0]!.sourceObstacle).toBe(
    original.srj.obstacles[0]!,
  )
  expect(original.buses[0]!.preferredExit).toBe("bottom-left")
  const steps = routeReservedSourceBusesSteps(original)
  let step = steps.next()
  while (!step.done) step = steps.next()
  const plans = step.value
  expect(plans).toHaveLength(4)
  if (!plans) throw new Error("Expected a complete four-lane crossbar")
  for (const plan of plans) {
    expect(plan.additionalVias).toHaveLength(2)
    expect(plan.sourceObstacle).toBe(
      original.buses[0]!.connections[plan.connectionIndex]!.sourceObstacle,
    )
    expect(plan.targetPoint).toEqual(
      original.buses[0]!.connections[plan.connectionIndex]!.targetPoint,
    )
    expect(plan.exitEdge).toBe("left")
    expect(plan.cornerBandSide).toBe("minimum")
    expect(plan.exitPoint.x).toBe(-5)
    expect(plan.exitPoint.y).toBeLessThan(0)
    expect(new Set(plan.segments.map((segment) => segment.layer))).toEqual(
      new Set(["top", "inner1"]),
    )
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: original.srj,
    plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: original.srj,
      outputSrj,
      plans,
      preparedBuses: original.buses,
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 4, issues: [] })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...original.srj,
        connections: [],
        traces: plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
