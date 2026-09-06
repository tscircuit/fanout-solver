import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  createFanoutPlanClearanceValidator,
  fanoutPlansAreClear,
} from "lib/route-bus"
import type { FanoutRoutePlan, Point2D } from "lib/types"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("cached clearance rechecks replacement traces and vias during length tuning", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -2, maxY: 2 }
  const pads: Obstacle[] = [-0.5, 0.5].map((y, i) => ({
    type: "rect",
    center: { x: -2, y },
    width: 0.2,
    height: 0.2,
    layers: ["top"],
    connectedTo: [`N${i}`],
  }))
  const makePlan = (index: number, points: Point2D[]): FanoutRoutePlan => ({
    busId: `B${index}`,
    connectionName: `N${index}`,
    connectionIndex: index,
    sourcePointIndex: 0,
    sourcePoint: { ...pads[index]!.center, layer: "top" },
    sourceObstacle: pads[index]!,
    sourceLayer: "top",
    targetLayer: "top",
    targetPoint: { x: 3, y: pads[index]!.center.y, layer: "top" },
    termination: { type: "boundary" },
    direction: "right",
    exitPoint: points.at(-1)!,
    trace: {
      type: "pcb_trace",
      pcb_trace_id: `T${index}`,
      connection_name: `N${index}`,
      route: points.map((p) => ({
        route_type: "wire",
        ...p,
        layer: "top",
        width: 0.1,
      })),
    },
    segments: points
      .slice(1)
      .map((end, i) => ({ start: points[i]!, end, layer: "top", width: 0.1 })),
    length: points
      .slice(1)
      .reduce(
        (sum, p, i) => sum + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y),
        0,
      ),
  })
  const a = makePlan(0, [
    { x: -2, y: -0.5 },
    { x: 3, y: -0.5 },
  ])
  const b = makePlan(1, [
    { x: -2, y: 0.5 },
    { x: 3, y: 0.5 },
  ])
  const tuned = makePlan(0, [
    a.sourcePoint,
    { x: -1, y: -0.5 },
    { x: -0.5, y: -1 },
    { x: 0.5, y: -1 },
    { x: 1, y: -0.5 },
    a.exitPoint,
  ])
  const crossing = makePlan(0, [
    a.sourcePoint,
    { x: 0, y: 1.5 },
    { x: 2, y: -0.5 },
    a.exitPoint,
  ])
  const blockedVia: FanoutRoutePlan = {
    ...a,
    via: {
      center: { x: 0, y: 0.5 },
      diameter: 0.3,
      holeDiameter: 0.15,
      fromLayer: "top",
      toLayer: "bottom",
      spanLayers: ["top", "bottom"],
    },
  }
  const outside = makePlan(0, [a.sourcePoint, { x: 4, y: -0.5 }])
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: 0.1,
    obstacles: pads,
    connections: [a, b].map((p) => ({
      name: p.connectionName,
      pointsToConnect: [p.sourcePoint, p.targetPoint],
    })),
  }
  const rules = {
    srj,
    sharedBoundary: bounds,
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  }
  const cached = createFanoutPlanClearanceValidator(rules)
  for (const [replacement, expected] of [
    [a, true],
    [a, true],
    [tuned, true],
    [crossing, false],
    [tuned, true],
    [blockedVia, false],
    [outside, false],
    [a, true],
  ] as const) {
    for (const plans of [
      [replacement, b],
      [b, replacement],
    ]) {
      expect(cached(plans)).toBe(expected)
      expect(cached(plans)).toBe(fanoutPlansAreClear({ ...rules, plans }))
    }
  }
  expect(cached([a, a])).toBe(fanoutPlansAreClear({ ...rules, plans: [a, a] }))
  expect(
    createFanoutPlanClearanceValidator({ ...rules, clearance: 1 })([a, b]),
  ).toBe(false)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: [tuned.trace, b.trace],
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
