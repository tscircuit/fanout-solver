import { expect, test } from "bun:test"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { routeAdaptiveLeftCrossbarBusSteps } from "lib/route-adaptive-left-crossbar-bus"
import type { PeripheralSourceEscape } from "lib/route-peripheral-source-escapes"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

// Three signal pads share a small package grid. Their left-side escape order
// is A, B, C, while their required right-side target order is B, A, C.
test("connects unordered source exits through an adaptive peripheral crossbar", async () => {
  const layerNames = [
    "top",
    "inner1",
    "inner2",
    "inner3",
    "inner4",
    "inner5",
    "inner6",
    "bottom",
  ]
  const traceWidth = 0.1,
    clearance = 0.1,
    viaDiameter = 0.3,
    viaHoleDiameter = 0.15
  const sharedBoundary = { minX: -5, maxX: 5, minY: -5, maxY: 5 }
  const sourceBoundary = { minX: -3, maxX: 3, minY: -1, maxY: 3 }
  const fixtures = [
    { source: { x: -2, y: 2 }, via: { x: -1.5, y: 2.5 }, targetY: -2.5 },
    { source: { x: -1, y: 1 }, via: { x: -1.5, y: 1.5 }, targetY: -2.9 },
    { source: { x: -2, y: 0 }, via: { x: -2.5, y: 0.5 }, targetY: -2.1 },
  ]
  const obstacles: Obstacle[] = [-2, -1, 0].flatMap((x) =>
    [0, 1, 2].map((y) => ({
      type: "rect" as const,
      shape: "circle" as const,
      center: { x, y },
      width: 0.36,
      height: 0.36,
      layers: ["top"],
      componentId: "U1",
      connectedTo: [],
    })),
  )
  const connections: PreparedConnection[] = fixtures.map(
    (fixture, connectionIndex) => {
      const name = `signal-${"ABC"[connectionIndex]}`
      const connection: SimpleRouteConnection = {
        name,
        pointsToConnect: [
          {
            ...fixture.source,
            layer: "top",
            pointId: `${name}:source`,
            pcb_port_id: `${name}:pad`,
          },
          {
            x: sharedBoundary.maxX,
            y: fixture.targetY,
            layer: "bottom",
            pointId: `${name}:target`,
          },
        ],
      }
      const sourceObstacle = obstacles.find(
        (o) =>
          o.center.x === fixture.source.x && o.center.y === fixture.source.y,
      )!
      sourceObstacle.connectedTo.push(name)
      return {
        connection,
        connectionIndex,
        sourcePoint: connection.pointsToConnect[0]!,
        sourcePointIndex: 0,
        sourceLayer: "top",
        sourceObstacle,
        targetPoint: connection.pointsToConnect[1]!,
        exitTargetPoint: connection.pointsToConnect[1]!,
        hasExplicitExitTarget: true,
        hasExplicitLayeredExitTarget: true,
      }
    },
  )
  const bus: PreparedBus = {
    busId: "permuted-corner",
    componentId: "U1",
    componentObstacles: obstacles,
    componentBounds: { minX: -2.18, maxX: 0.18, minY: -0.18, maxY: 2.18 },
    sharedBoundary,
    xCoordinates: [-2, -1, 0],
    yCoordinates: [0, 1, 2],
    pitchX: 1,
    pitchY: 1,
    termination: { type: "boundary" },
    direction: "right",
    exitEdge: "right",
    preferredExit: "bottom-right",
    allowedLayers: ["bottom", "inner5"],
    routableEscapeLayers: ["bottom", "inner5"],
    connections,
  }
  const srj: SimpleRouteJson = {
    layerCount: layerNames.length,
    minTraceWidth: traceWidth,
    bounds: sharedBoundary,
    obstacles,
    connections: connections.map((c) => c.connection),
  }
  const sourceEscapes: PeripheralSourceEscape[] = fixtures.map(
    (fixture, connectionIndex) => ({
      connectionIndex,
      connectionName: connections[connectionIndex]!.connection.name,
      segments: [
        {
          start: fixture.source,
          end: fixture.via,
          width: traceWidth,
          layer: "top",
        },
      ],
      via: {
        center: fixture.via,
        diameter: viaDiameter,
        holeDiameter: viaHoleDiameter,
        fromLayer: "top",
        toLayer: "bottom",
        spanLayers: layerNames,
      },
    }),
  )
  const params = {
    srj,
    bus,
    sourceBoundary,
    sourceEscapes,
    targetLayer: "bottom",
    layerNames,
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    compactBusTracks: false,
    acceptedPlans: [],
  }
  const run = (candidateBus: PreparedBus): FanoutRoutePlan[] | null => {
    const steps = routeAdaptiveLeftCrossbarBusSteps({
      ...params,
      bus: candidateBus,
    })
    let result = steps.next()
    while (!result.done) result = steps.next()
    return result.value
  }
  const plans = run(bus)
  expect(plans).toHaveLength(3)
  if (!plans) throw new Error("Expected a complete three-signal crossbar")
  for (const plan of plans) {
    const original = connections[plan.connectionIndex]!
    expect(plan.sourcePoint).toEqual(original.sourcePoint)
    expect(plan.exitPoint.x).toBe(sharedBoundary.maxX)
    expect(plan.exitPoint.y).toBeCloseTo(
      fixtures[plan.connectionIndex]!.targetY,
      12,
    )
    expect(plan.segments[0]!.start).toEqual(
      fixtures[plan.connectionIndex]!.source,
    )
    expect(plan.segments.at(-1)!.end).toEqual(plan.exitPoint)
    expect(plan.targetLayer).toBe("bottom")
    expect(
      plan.trace.route.filter((point) => point.route_type === "via"),
    ).toHaveLength(3)
    expect(plan.additionalVias).toHaveLength(2)
    expect(plan.additionalVias!.map((v) => [v.fromLayer, v.toLayer])).toEqual([
      ["bottom", "inner5"],
      ["inner5", "bottom"],
    ])
    for (const via of [plan.via!, ...plan.additionalVias!])
      expect(via.spanLayers).toEqual(layerNames)
    expect(new Set(plan.segments.map((segment) => segment.layer))).toEqual(
      new Set(["top", "bottom", "inner5"]),
    )
  }
  expect(
    plans
      .toSorted((a, b) => a.exitPoint.y - b.exitPoint.y)
      .map((p) => p.connectionName),
  ).toEqual(["signal-B", "signal-A", "signal-C"])
  expect(
    run({
      ...bus,
      allowedLayers: ["bottom"],
      routableEscapeLayers: ["bottom"],
    }),
  ).toBeNull()
  const routedSrj = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 3,
    checkedViaCount: 9,
    issues: [],
  })
  const graphics: GraphicsObject = {
    title: "A permitted second layer restores the requested target order",
    circles: [],
    lines: [],
    texts: [],
  }
  const viaCenters = plans.flatMap((plan) =>
    [plan.via!, ...plan.additionalVias!].map((via) => via.center),
  )
  graphics.texts!.push(
    {
      x: 0,
      y: 3.65,
      text: "Permuted targets connected through a two-layer crossbar",
      fontSize: 0.26,
    },
    { x: -2.7, y: 3.2, text: "bottom", color: "#d9480f", fontSize: 0.23 },
    { x: -0.8, y: 3.2, text: "inner5", color: "#1971c2", fontSize: 0.23 },
    {
      x: 1.4,
      y: 3.2,
      text: "TOP source prefix",
      color: "#868e96",
      fontSize: 0.23,
    },
  )
  for (const obstacle of obstacles)
    graphics.circles!.push({
      center: obstacle.center,
      radius: obstacle.width / 2,
      fill: "#e9ecef",
    })
  for (const plan of plans)
    for (const segment of plan.segments)
      graphics.lines!.push({
        points: [segment.start, segment.end],
        strokeWidth: traceWidth,
        strokeColor:
          segment.layer === "bottom"
            ? "#d9480f"
            : segment.layer === "inner5"
              ? "#1971c2"
              : "#868e96",
      })
  for (const center of viaCenters)
    graphics.circles!.push(
      { center, radius: viaDiameter / 2, fill: "#495057" },
      { center, radius: viaHoleDiameter / 2, fill: "#fff" },
    )
  for (const plan of plans)
    graphics.texts!.push(
      {
        x: sharedBoundary.maxX + 0.18,
        y: plan.exitPoint.y,
        text: plan.connectionName.at(-1)!,
        color: "#d9480f",
        fontSize: 0.24,
        anchorSide: "center_left",
      },
      {
        x: plan.sourcePoint.x + 0.15,
        y: plan.sourcePoint.y - 0.28,
        text: plan.connectionName.at(-1)!,
        color: "#495057",
        fontSize: 0.24,
      },
    )
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
