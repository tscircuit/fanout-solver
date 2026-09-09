import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { repairBoundaryRouteTails } from "lib/repair-boundary-route-tails"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { fanoutPlansAreClear } from "lib/route-bus"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("aligns crowded boundary links with their exact exit tracks when the native grid misses their phase", async () => {
  const traceWidth = 0.08128,
    clearance = 0.08128,
    viaDiameter = 0.04,
    viaHoleDiameter = 0.02,
    layerNames = ["top", "inner1", "bottom"]
  const sharedBoundary = { minX: -2, maxX: 2, minY: -2, maxY: 2 }
  const pads: Obstacle[] = Array.from(
    { length: 8 },
    (_, i) => (i - 3.5) * 0.32512,
  ).map((y, i) => ({
    type: "rect",
    shape: "circle",
    center: { x: 0.4, y },
    width: 0.08,
    height: 0.08,
    layers: ["top"],
    componentId: "U1",
    connectedTo: [`signal${i}`],
  }))
  const connections: PreparedConnection[] = pads.map((sourceObstacle, i) => {
    const sourcePoint = {
        ...sourceObstacle.center,
        layer: "top",
        pointId: `pad${i}`,
      },
      targetPoint = {
        x: -3,
        y: sourceObstacle.center.y / 2 + 0.00206,
        layer: "bottom",
      }
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
    direction: "left",
    preferredExit: "left",
    exitEdge: "left",
    componentId: "U1",
    componentObstacles: pads,
    componentBounds: {
      minX: 0.36,
      maxX: 0.44,
      minY: pads[0]!.center.y - 0.04,
      maxY: pads.at(-1)!.center.y + 0.04,
    },
    sharedBoundary,
    xCoordinates: [0.4],
    yCoordinates: pads.map((p) => p.center.y),
    pitchX: 0.16,
    pitchY: 0.32512,
    termination: { type: "boundary" },
    allowedLayers: ["inner1", "bottom"],
    routableEscapeLayers: ["inner1", "bottom"],
    connections,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 3,
    minTraceWidth: traceWidth,
    bounds: sharedBoundary,
    obstacles: pads,
    connections: connections.map((c) => c.connection),
  }
  const config = {
    traceWidth,
    clearance,
    viaDiameter,
    viaHoleDiameter,
    layerNames,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
  const original = connections.map((connection) => {
    const viaPoint = { x: 0, y: connection.sourcePoint.y },
      finalViaPoint = { x: -1.2, y: viaPoint.y },
      exitPoint = { x: -2, y: connection.targetPoint.y }
    const prefix = buildViaMinimalWindingPlan({
      ...config,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "inner1",
      targetLayerPoints: [viaPoint, finalViaPoint],
    })
    const tail = [finalViaPoint, { x: -1.96, y: viaPoint.y / 2 }, exitPoint]
    const segments = [
      ...prefix.segments,
      ...tail.slice(1).map((end, i) => ({
        start: tail[i]!,
        end,
        layer: "bottom",
        width: traceWidth,
      })),
    ]
    return {
      ...prefix,
      targetLayer: "bottom",
      additionalVias: [
        {
          center: finalViaPoint,
          diameter: viaDiameter,
          holeDiameter: viaHoleDiameter,
          fromLayer: "inner1",
          toLayer: "bottom",
          spanLayers: layerNames,
        },
      ],
      segments,
      length: segments.reduce(
        (sum, segment) =>
          sum +
          Math.hypot(
            segment.end.x - segment.start.x,
            segment.end.y - segment.start.y,
          ),
        0,
      ),
      trace: {
        ...prefix.trace,
        route: [
          ...prefix.trace.route,
          {
            route_type: "via" as const,
            ...finalViaPoint,
            from_layer: "inner1",
            to_layer: "bottom",
            via_diameter: viaDiameter,
            via_hole_diameter: viaHoleDiameter,
          },
          ...tail.map((point) => ({
            route_type: "wire" as const,
            ...point,
            layer: "bottom",
            width: traceWidth,
          })),
        ],
      },
    }
  })
  expect(
    fanoutPlansAreClear({
      ...config,
      srj: inputSrj,
      sharedBoundary,
      plans: original,
    }),
  ).toBe(false)
  const before = structuredClone(original),
    repaired = repairBoundaryRouteTails({
      ...config,
      // A caller may pass its original routing context through to this helper.
      // Those pad prefixes must not be reused for temporary same-layer cuts.
      ...{
        sourceEscapePaths: new Map(
          original.map((plan) => [
            plan.connectionIndex,
            [plan.sourcePoint, plan.via!.center],
          ]),
        ),
      },
      inputSrj,
      gridOrigin: { x: -1.2, y: 0 },
      preparedBuses: [bus],
      plans: original,
    })
  expect(repaired).toHaveLength(8)
  if (!repaired) throw new Error("Expected all bus lanes to be repaired")
  expect(original).toEqual(before)
  for (let i = 0; i < repaired.length; i++) {
    const plan = repaired[i]!
    expect(plan.exitPoint).toEqual(original[i]!.exitPoint)
    expect(plan.via).toEqual(original[i]!.via)
    expect(plan.sourcePoint).toEqual(original[i]!.sourcePoint)
    expect(plan.sourceObstacle).toBe(original[i]!.sourceObstacle)
    expect(plan.busId).toBe("DATA")
    expect(plan.targetLayer).toBe("bottom")
    expect(plan.exitEdge).toBe("left")
    expect(plan.additionalVias).toEqual(original[i]!.additionalVias)
    expect(plan.sourceEscapeSegmentCount).toBe(
      original[i]!.sourceEscapeSegmentCount,
    )
    expect(plan.segments.slice(0, 2)).toEqual(original[i]!.segments.slice(0, 2))
    expect(
      plan.trace.route.filter((point) => point.route_type === "via"),
    ).toEqual(
      original[i]!.trace.route.filter((point) => point.route_type === "via"),
    )
    expect(plan.segments[0]).toEqual(original[i]!.segments[0])
  }
  expect(
    fanoutPlansAreClear({
      ...config,
      srj: inputSrj,
      sharedBoundary,
      plans: repaired,
    }),
  ).toBe(true)
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: repaired,
    layerNames,
  })
  const drc = validateRoutedCopperDrc({
    inputSrj,
    routedSrj: outputSrj,
    clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(drc.valid).toBe(true)
  const validation = validateFanoutSolution({
    inputSrj,
    outputSrj,
    plans: repaired,
    preparedBuses: [bus],
    sharedBoundary,
    clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(validation.valid).toBe(true)
  expect(
    repairBoundaryRouteTails({
      ...config,
      inputSrj,
      preparedBuses: [bus],
      plans: repaired,
    }),
  ).toEqual(repaired)
  const graphics: GraphicsObject = { lines: [], circles: [], texts: [] }
  for (const [plans, offset, label] of [
    [original, 0, "Before: exits miss native grid phase"],
    [repaired, 5, "After: same exit tracks and vias"],
  ] as const) {
    graphics.texts!.push({
      x: -2 + offset,
      y: 1.6,
      text: label,
      anchorSide: "bottom_left",
      fontSize: 0.13,
    })
    graphics.lines!.push({
      points: [
        { x: -2 + offset, y: -0.7 },
        { x: -2 + offset, y: 0.7 },
      ],
      strokeColor: "#64748b",
      strokeWidth: 0.015,
    })
    for (const [i, plan] of plans.entries())
      for (const segment of plan.segments)
        graphics.lines!.push({
          points: [segment.start, segment.end].map((p) => ({
            x: p.x + offset,
            y: p.y,
          })),
          strokeColor: ["#2563eb", "#059669", "#d97706"][i % 3],
          strokeWidth: segment.width,
        })
    for (const plan of plans)
      for (const via of [plan.via!, ...plan.additionalVias!])
        graphics.circles!.push({
          center: { x: via.center.x + offset, y: via.center.y },
          radius: viaDiameter / 2,
          fill: "#334155",
        })
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
