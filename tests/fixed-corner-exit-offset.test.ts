import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeBus, type RouteBusParams } from "lib/route-bus"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("fixed corner slots preserve bus order when the upper bus routes first", async () => {
  const boundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const layerNames = ["top", "bottom"]
  const definitions = [
    { name: "LOWER_0", y: 0.6, targetY: 1.9 },
    { name: "LOWER_1", y: 1.25, targetY: 2.3 },
    { name: "UPPER_0", y: 3.5, targetY: 2.7 },
    { name: "UPPER_1", y: 4.15, targetY: 3.1 },
  ]
  const pads = definitions.map(({ name, y }) => ({
    obstacleId: name,
    componentId: "U1",
    type: "rect" as const,
    shape: "circle" as const,
    center: { x: 0, y },
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    connectedTo: [name],
  }))
  const connections = definitions.map(({ name, targetY }, index) => ({
    name,
    pointsToConnect: [
      { ...pads[index]!.center, layer: "top", pointId: name },
      { x: 6, y: targetY, layer: "bottom", pointId: `${name}-target` },
    ],
  }))
  const srj: SimpleRouteJson = {
    bounds: boundary,
    layerCount: layerNames.length,
    minTraceWidth: 0.1,
    obstacles: pads,
    connections,
  }
  const prepared: PreparedConnection[] = connections.map(
    (connection, index) => ({
      connection,
      connectionIndex: index,
      sourcePointIndex: 0,
      sourcePoint: connection.pointsToConnect[0]!,
      sourceLayer: "top",
      sourceObstacle: pads[index]!,
      targetPoint: connection.pointsToConnect[1]!,
      exitTargetPoint: connection.pointsToConnect[1]!,
      hasExplicitExitTarget: true,
      hasExplicitLayeredExitTarget: true,
    }),
  )
  const buses: PreparedBus[] = [
    [0, 1],
    [2, 3],
  ].map((indices, index) => ({
    busId: index === 0 ? "LOWER" : "UPPER",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -0.15, maxX: 0.15, minY: 0.45, maxY: 4.3 },
    sharedBoundary: boundary,
    xCoordinates: [0],
    yCoordinates: definitions.map(({ y }) => y),
    pitchX: 0.65,
    pitchY: 0.65,
    direction: "up",
    exitEdge: "right",
    preferredExit: "top-right",
    cornerBandConnectionCount: 4,
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    termination: { type: "boundary" },
    connections: indices.map((connectionIndex) => prepared[connectionIndex]!),
  }))
  const params: Omit<RouteBusParams, "bus" | "acceptedPlans"> = {
    srj,
    targetLayer: "bottom",
    layerNames,
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    compactBusTracks: true,
    allowBlindAndBuriedVias: false,
    alignWindingGridToPads: true,
    fixedViaPointsByConnectionIndex: new Map(
      prepared.map((connection) => [
        connection.connectionIndex,
        { x: 0.3, y: connection.sourcePoint.y + 0.3 },
      ]),
    ),
  }
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      routeBus({
        ...params,
        bus: buses[1]!,
        acceptedPlans: [],
        cornerExitLaneOffset: offset,
      }),
    ).toThrow("cornerExitLaneOffset must be a non-negative safe integer")
  }
  const upper = routeBus({
    ...params,
    bus: buses[1]!,
    acceptedPlans: [],
    cornerExitLaneOffset: 2,
  })
  expect(upper).toHaveLength(2)
  if (!upper) throw new Error("Expected the upper bus to route first")
  const lower = routeBus({
    ...params,
    bus: buses[0]!,
    acceptedPlans: upper,
    cornerExitLaneOffset: 0,
  })
  expect(lower).toHaveLength(2)
  if (!lower)
    throw new Error("Expected the lower bus to retain its first slots")
  const plans = [...upper, ...lower]
  expect(plans.map((plan) => plan.busId)).toEqual([
    "UPPER",
    "UPPER",
    "LOWER",
    "LOWER",
  ])
  for (const plan of plans) {
    const definition = definitions[plan.connectionIndex]!
    expect(plan.exitPoint.x).toBe(boundary.maxX)
    expect(plan.exitPoint.y).toBeCloseTo(definition.targetY, 8)
    expect(plan.targetLayer).toBe("bottom")
    expect(plan.direction).toBe("up")
    expect(plan.cornerBandSide).toBe("maximum")
    expect(plan.targetPoint).toEqual(
      prepared[plan.connectionIndex]!.targetPoint,
    )
  }
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: buses,
      sharedBoundary: boundary,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 4,
    brokenOutConnectionCount: 4,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 4, issues: [] })
  const graphics = visualizeSimpleRouteJson({ ...output, connections: [] })
  graphics.texts = [
    {
      x: -1.8,
      y: 3.8,
      text: "Upper bus routes first",
      fontSize: 0.2,
      color: "#2563eb",
    },
    {
      x: -1.8,
      y: 0.6,
      text: "Lower bus keeps slots 0–1",
      fontSize: 0.2,
      color: "#2563eb",
    },
  ]
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
  // Cold SVG rendering can exceed Bun's five-second default on macOS CI.
}, 15_000)
