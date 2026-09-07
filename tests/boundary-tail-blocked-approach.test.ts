import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject, type GraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { repairBoundaryRouteTails } from "lib/repair-boundary-route-tails"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"

test("repairs a neighboring tail that blocks another lane’s inward exit approach", async () => {
  const bounds = { minX: 0, maxX: 5, minY: 4.5, maxY: 9.825 }
  const config = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.12,
    layerNames: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
  const paths = [
    [
      [2.0326, 5.85156],
      [2.0326, 6.82692],
      [2.11388, 6.82692],
      [2.11388, 7.96484],
      [2.0326, 7.96484],
      [2.0326, 8.45252],
      [1.95132, 8.45252],
      [1.95132, 9.67172],
      [1.87004, 9.67172],
      [1.87004, 9.753],
      [1.54492, 9.753],
      [1.5143440816326525, 9.825],
    ],
    [
      [2.439, 5.85156],
      [2.439, 7.63972],
      [2.60156, 7.63972],
      [2.60156, 8.37124],
      [2.68284, 8.37124],
      [2.68284, 8.69636],
      [2.60156, 8.69636],
      [2.60156, 9.26532],
      [2.439, 9.26532],
      [2.439, 9.67172],
      [2.35772, 9.67172],
      [2.35772, 9.8244],
      [2.11388, 9.8244],
      [2.0169040816326533, 9.825],
    ],
    [
      [3.2518, 5.85156],
      [3.2518, 9.10276],
      [3.17052, 9.10276],
      [3.17052, 9.26532],
      [2.8454, 9.26532],
      [2.8454, 9.3466],
      [2.76412, 9.3466],
      [2.76412, 9.42788],
      [2.60156, 9.42788],
      [2.60156, 9.8244],
      [2.5194640816326523, 9.825],
    ],
  ].map((points) => points.map(([x, y]) => ({ x: x!, y: y! })))
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: config.traceWidth,
    obstacles: paths.map((points, index) => ({
      type: "rect",
      shape: "circle",
      center: { x: points[0]!.x, y: 5.4 },
      width: 0.08,
      height: 0.08,
      componentId: "U1",
      connectedTo: [`N${index}`],
      layers: ["top"],
    })),
    connections: paths.map((points, index) => ({
      name: `N${index}`,
      pointsToConnect: [
        { x: points[0]!.x, y: 5.4, layer: "top" },
        { x: points.at(-1)!.x, y: 11, layer: "bottom" },
      ],
    })),
  }
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    escapeLayers: ["bottom"],
    buses: [
      {
        busId: "DATA",
        connectionNames: ["N0", "N1", "N2"],
        sourceComponentId: "U1",
        direction: "up",
        preferredExit: "top",
        exitEdge: "top",
        allowedLayers: ["bottom"],
      },
    ],
  })
  const bus = preparedBuses[0]!
  const plans = bus.connections.map((connection, index) => {
    const viaPoint = paths[index]![0]!
    const exitPoint = paths[index]!.at(-1)!
    return buildViaMinimalWindingPlan({
      ...config,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints: paths[index]!,
    })
  })
  const validate = (routes: typeof plans) =>
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: routes.map((plan) => plan.trace) },
      clearance: config.clearance,
      allowBlindAndBuriedVias: false,
    })
  expect(validate(plans).valid).toBe(false)
  // N0 has no actual clearance conflict, but its inward tail fences N1.
  expect(validate([plans[0]!, plans[1]!]).valid).toBe(true)
  const original = structuredClone(plans)
  const repaired = repairBoundaryRouteTails({
    ...config,
    inputSrj,
    plans,
    preparedBuses,
    gridOrigin: { x: 0.0006, y: 0.08068 },
  })!
  expect(repaired).toHaveLength(3)
  expect(plans).toEqual(original)
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
        if (Math.abs(point.y - bounds.maxY) < 1e-7)
          expect(
            Math.hypot(point.x - plan.exitPoint.x, point.y - plan.exitPoint.y),
          ).toBeLessThan(1e-7)
  }
  expect(validate(repaired)).toMatchObject({
    valid: true,
    checkedTraceCount: 3,
    checkedViaCount: 3,
    issues: [],
  })
  const normalized = normalizeFanoutPlanCorners({
    ...config,
    inputSrj,
    preparedBuses,
    plans: repaired,
  })!
  expect(normalized).toHaveLength(3)
  expect(validate(normalized).valid).toBe(true)
  const graphics: GraphicsObject = { lines: [], circles: [], texts: [] }
  for (const [routes, offset, label] of [
    [plans, 0, "Before: retained neighbor blocks approach"],
    [normalized, 4, "After: neighboring tails repaired together"],
  ] as const) {
    graphics.texts!.push({
      x: 1.1 + offset,
      y: 10.2,
      text: label,
      fontSize: 0.12,
      anchorSide: "bottom_left",
    })
    graphics.lines!.push({
      points: [
        { x: 1.1 + offset, y: bounds.maxY },
        { x: 3.6 + offset, y: bounds.maxY },
      ],
      strokeColor: "#64748b",
      strokeWidth: 0.015,
    })
    for (const [index, plan] of routes.entries()) {
      for (const segment of plan.segments)
        graphics.lines!.push({
          points: [segment.start, segment.end].map((p) => ({
            x: p.x + offset,
            y: p.y,
          })),
          strokeColor: ["#2563eb", "#059669", "#d97706"][index],
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
