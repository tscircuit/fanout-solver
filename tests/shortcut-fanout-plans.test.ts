import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { getRoutedTraceCopper } from "lib/get-routed-trace-copper"
import { shortcutFanoutPlans } from "lib/shortcut-fanout-plans"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import type {
  FanoutRoutePlan,
  PreparedBus,
  PreparedConnection,
} from "lib/types"

test("shortens an overlong lane around obstacles while preserving its source and additional via", async () => {
  const layerNames = ["top", "inner1", "bottom"],
    traceWidth = 0.05,
    clearance = 0.05,
    viaDiameter = 0.14,
    viaHoleDiameter = 0.07
  const sharedBoundary = { minX: -2, maxX: 2, minY: -2, maxY: 2 }
  const pads: Obstacle[] = [-0.6, 0.6].map((y, i) => ({
    type: "rect",
    shape: "circle",
    center: { x: -1.8, y },
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`signal${i}`],
  }))
  const blockingPad: Obstacle = {
    type: "rect",
    center: { x: -0.8, y: 0.6 },
    width: 0.24,
    height: 0.24,
    layers: ["inner1"],
    connectedTo: ["other-net"],
  }
  const connections: PreparedConnection[] = pads.map((sourceObstacle, i) => {
    const sourcePoint = {
        ...sourceObstacle.center,
        layer: "top",
        pointId: `pad${i}`,
      },
      targetPoint = { x: 3, y: sourcePoint.y, layer: "bottom" }
    return {
      connection: {
        name: `signal${i}`,
        pointsToConnect: [sourcePoint, targetPoint],
      },
      connectionIndex: i,
      sourcePointIndex: 0,
      sourcePoint,
      sourceLayer: "top",
      sourceObstacle,
      targetPoint,
      exitTargetPoint: targetPoint,
      hasExplicitLayeredExitTarget: true,
    }
  })
  const bus: PreparedBus = {
    busId: "DATA",
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: { minX: -1.84, maxX: -1.76, minY: -0.64, maxY: 0.64 },
    sharedBoundary,
    pitchX: 1.2,
    pitchY: 1.2,
    xCoordinates: [-1.8],
    yCoordinates: [-0.6, 0.6],
    termination: { type: "boundary" },
    allowedLayers: ["inner1", "bottom"],
    routableEscapeLayers: ["inner1", "bottom"],
    maxLengthSkew: 0.5,
    connections,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: traceWidth,
    bounds: sharedBoundary,
    obstacles: [...pads, blockingPad],
    connections: connections.map((c) => c.connection),
  }
  const config = {
    layerNames,
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
  const plans = connections.map((connection) => {
    const viaPoint = { x: -1.5, y: connection.sourcePoint.y },
      exitPoint = { x: 2, y: connection.sourcePoint.y }
    return buildViaMinimalWindingPlan({
      ...config,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints: [viaPoint, exitPoint],
    })
  })
  const long = plans[1]!,
    firstVia = { ...long.via!, toLayer: "inner1" },
    additionalVia = {
      ...long.via!,
      center: { x: 0.2, y: 0.6 },
      fromLayer: "inner1",
      toLayer: "bottom",
    }
  const points = [
    { x: -1.5, y: 0.6 },
    { x: -1.5, y: 1.25 },
    { x: -1.35, y: 1.4 },
    { x: 0.05, y: 1.4 },
    { x: 0.2, y: 1.25 },
    { x: 0.2, y: 0.9 },
    { x: 0.2, y: 0.6 },
  ]
  const trace: FanoutRoutePlan["trace"] = {
    ...long.trace,
    route: [
      ...long.trace.route.slice(0, 2),
      {
        route_type: "via",
        ...firstVia.center,
        from_layer: "top",
        to_layer: "inner1",
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      },
      ...points.map((p) => ({
        route_type: "wire" as const,
        ...p,
        layer: "inner1",
        width: traceWidth,
      })),
      {
        route_type: "via",
        ...additionalVia.center,
        from_layer: "inner1",
        to_layer: "bottom",
        via_diameter: viaDiameter,
        via_hole_diameter: viaHoleDiameter,
      },
      {
        route_type: "wire",
        ...additionalVia.center,
        layer: "bottom",
        width: traceWidth,
      },
      {
        route_type: "wire",
        ...long.exitPoint,
        layer: "bottom",
        width: traceWidth,
      },
    ],
  }
  const segments = getRoutedTraceCopper(inputSrj, trace, false).segments
  plans[1] = {
    ...long,
    via: firstVia,
    additionalVias: [additionalVia],
    trace,
    segments,
    length: segments.reduce(
      (sum, s) => sum + Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y),
      0,
    ),
  }
  const before = structuredClone(plans),
    params = {
      ...config,
      inputSrj,
      plans,
      preparedBuses: [bus],
      selectedBusIds: new Set(["DATA"]),
      selectedConnectionIndices: new Set([0, 1]),
    }
  expect(plans[1]!.length - plans[0]!.length).toBeGreaterThan(
    bus.maxLengthSkew!,
  )
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: plans.map((p) => p.trace) },
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  const shortened = shortcutFanoutPlans(params)
  expect(shortened).toHaveLength(2)
  if (!shortened) throw new Error("Expected complete clear shortened plans")
  expect(plans).toEqual(before)
  expect(shortened[0]).toBe(plans[0])
  expect(shortened[1]!.length).toBeLessThan(plans[1]!.length - 0.5)
  expect(shortened[1]!.length).toBeGreaterThanOrEqual(plans[0]!.length)
  expect(shortened[1]!.via).toBe(firstVia)
  expect(shortened[1]!.additionalVias).toBe(plans[1]!.additionalVias)
  expect(shortened[1]!.sourcePoint).toBe(plans[1]!.sourcePoint)
  expect(shortened[1]!.sourceObstacle).toBe(plans[1]!.sourceObstacle)
  expect(shortened[1]!.exitPoint).toBe(plans[1]!.exitPoint)
  expect(shortened[1]!.trace.route.slice(0, 3)).toEqual(
    plans[1]!.trace.route.slice(0, 3),
  )
  expect(
    shortened[1]!.trace.route.filter((p) => p.route_type === "via"),
  ).toEqual(plans[1]!.trace.route.filter((p) => p.route_type === "via"))
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: shortened,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans: shortened,
      preparedBuses: [bus],
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    shortcutFanoutPlans({ ...params, selectedConnectionIndices: new Set() }),
  ).toEqual(plans)
  const graphics: GraphicsObject = {
    lines: [],
    rects: [],
    circles: [],
    texts: [],
  }
  for (const [ps, offset, label] of [
    [plans, 0, "Before: excess length around a pad"],
    [shortened, 5, "After: source and both vias stay fixed"],
  ] as const) {
    graphics.texts!.push({
      x: -2 + offset,
      y: 1.8,
      text: label,
      fontSize: 0.12,
      anchorSide: "bottom_left",
    })
    graphics.rects!.push({
      center: { x: blockingPad.center.x + offset, y: blockingPad.center.y },
      width: blockingPad.width,
      height: blockingPad.height,
      fill: "#64748b",
    })
    for (const plan of ps) {
      for (const segment of plan.segments)
        graphics.lines!.push({
          points: [segment.start, segment.end].map((p) => ({
            x: p.x + offset,
            y: p.y,
          })),
          strokeColor: segment.layer === "inner1" ? "#7c3aed" : "#2563eb",
          strokeWidth: segment.width,
        })
      for (const via of [plan.via, ...(plan.additionalVias ?? [])])
        if (via)
          graphics.circles!.push({
            center: { x: via.center.x + offset, y: via.center.y },
            radius: via.diameter / 2,
            fill: "#334155",
          })
    }
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
