import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { repairBoundaryRouteTails } from "lib/repair-boundary-route-tails"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("a clear tail that reaches the boundary early is repaired before its exact exit", async () => {
  const bounds = { minX: -2, maxX: 1, minY: -1, maxY: 1 }
  const config = {
    traceWidth: 0.04,
    clearance: 0.04,
    viaDiameter: 0.08,
    viaHoleDiameter: 0.04,
    layerNames: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: config.traceWidth,
    obstacles: [-0.3, 0.5].map((y, index) => ({
      type: "rect",
      shape: "circle",
      center: { x: 0.4, y },
      width: 0.08,
      height: 0.08,
      componentId: "U1",
      connectedTo: [`N${index}`],
      layers: ["top"],
    })),
    connections: [-0.3, 0.5].map((y, index) => ({
      name: `N${index}`,
      pointsToConnect: [
        { x: 0.4, y, layer: "top" },
        { x: -3, y: index === 0 ? 0.1 : 0.5, layer: "bottom" },
      ],
    })),
  }
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    escapeLayers: ["bottom"],
    buses: [
      {
        busId: "DATA",
        connectionNames: ["N0", "N1"],
        sourceComponentId: "U1",
        direction: "left",
        preferredExit: "left",
        exitEdge: "left",
        allowedLayers: ["bottom"],
      },
    ],
  })
  const bus = preparedBuses[0]!
  const plans = bus.connections.map((connection, index) => {
    const viaPoint = { x: 0, y: connection.sourcePoint.y }
    const exitPoint = { x: -2, y: index === 0 ? 0.1 : 0.5 }
    return buildViaMinimalWindingPlan({
      ...config,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints:
        index === 0
          ? [viaPoint, { x: -1.7, y: -0.3 }, { x: -2, y: 0 }, exitPoint]
          : [viaPoint, exitPoint],
    })
  })
  const validate = (routes: typeof plans) =>
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: routes.map((plan) => plan.trace) },
      clearance: config.clearance,
      allowBlindAndBuriedVias: false,
    })
  expect(validate(plans)).toMatchObject({ valid: true, issues: [] })
  const original = structuredClone(plans)
  const repaired = repairBoundaryRouteTails({
    ...config,
    inputSrj,
    plans,
    preparedBuses,
  })!
  expect(repaired).toHaveLength(2)
  expect(plans).toEqual(original)
  expect(repaired[1]).toEqual(plans[1]!)
  expect(repaired[0]!.segments).not.toEqual(plans[0]!.segments)
  for (const [index, plan] of repaired.entries()) {
    expect(plan.via).toEqual(plans[index]!.via)
    expect(plan.sourcePoint).toEqual(plans[index]!.sourcePoint)
    expect(plan.sourceObstacle).toBe(plans[index]!.sourceObstacle)
    expect(plan.segments[0]).toEqual(plans[index]!.segments[0])
    expect(plan.exitPoint).toEqual(plans[index]!.exitPoint)
    expect(plan.targetLayer).toBe("bottom")
    for (const segment of plan.segments)
      for (const point of [segment.start, segment.end])
        if (Math.abs(point.x - bounds.minX) < 1e-7)
          expect(
            Math.hypot(point.x - plan.exitPoint.x, point.y - plan.exitPoint.y),
          ).toBeLessThan(1e-7)
  }
  expect(validate(repaired)).toMatchObject({
    valid: true,
    checkedTraceCount: 2,
    checkedViaCount: 2,
    issues: [],
  })
  const graphics: GraphicsObject = { lines: [], circles: [], texts: [] }
  for (const [routes, offset, label] of [
    [plans, 0, "Before: early boundary contact"],
    [repaired, 4, "After: exact exit only"],
  ] as const) {
    graphics.texts!.push({
      x: -2 + offset,
      y: 0.9,
      text: label,
      fontSize: 0.12,
      anchorSide: "bottom_left",
    })
    graphics.lines!.push({
      points: [
        { x: -2 + offset, y: -0.6 },
        { x: -2 + offset, y: 0.7 },
      ],
      strokeColor: "#64748b",
      strokeWidth: 0.015,
    })
    for (const [index, plan] of routes.entries()) {
      for (const segment of plan.segments)
        graphics.lines!.push({
          points: [segment.start, segment.end].map((point) => ({
            x: point.x + offset,
            y: point.y,
          })),
          strokeColor: ["#2563eb", "#059669"][index],
          strokeWidth: segment.width,
        })
      graphics.circles!.push({
        center: { x: plan.via!.center.x + offset, y: plan.via!.center.y },
        radius: config.viaDiameter / 2,
        fill: "#334155",
      })
    }
  }
  await expect(getSvgFromGraphicsObject(graphics)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
