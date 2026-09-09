import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeViaMinimalWindingAlternatives } from "lib/route-via-minimal-winding"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("an interior exit approach reaches the exact terminal without first following its boundary", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.2,
    viaHoleDiameter: 0.1,
  }
  const source = { x: -2.45, y: 0.7 },
    viaPoint = { x: -2.8, y: 0.7 },
    exitPoint = { x: -3, y: -1 }
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: rules.traceWidth,
    connections: [
      {
        name: "data",
        pointsToConnect: [
          { ...source, layer: "top", pointId: "P1", pcb_port_id: "P1" },
          { ...exitPoint, layer: "bottom" },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: source,
        width: 0.2,
        height: 0.2,
        componentId: "U1",
        obstacleId: "P1",
        layers: ["top"],
        connectedTo: ["data", "P1"],
      },
    ],
  }
  const prepared = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "data",
        sourceComponentId: "U1",
        connectionNames: ["data"],
        direction: "left",
        preferredExit: "left",
        allowedLayers: ["bottom"],
      },
    ],
  })
  const bus = { ...prepared[0]!, exitEdge: "left" as const }
  const params = {
    ...rules,
    srj,
    bus,
    targetLayer: "bottom",
    layerNames: ["top", "bottom"],
    terminals: [{ connection: bus.connections[0]!, viaPoint, exitPoint }],
    acceptedPlans: [],
    gridStep: 0.1,
    gridStepDivisor: 2 as const,
    gridOrigin: { x: 0, y: 0 },
    alignGridToPads: true,
    heuristicWeight: 2,
    maximumRouteOrderAttempts: 1,
  }
  const original = JSON.stringify({ srj, bus, viaPoint, exitPoint })
  const before = routeViaMinimalWindingAlternatives(params)[0]![0]!
  const touchesEarly = (point: { x: number; y: number }) =>
    Math.abs(point.x - bounds.minX) < 1e-7 &&
    Math.hypot(point.x - exitPoint.x, point.y - exitPoint.y) > 1e-7
  expect(
    before.segments.some((segment) =>
      [segment.start, segment.end].some(touchesEarly),
    ),
  ).toBe(true)
  const result = routeViaMinimalWindingAlternatives({
    ...params,
    forbidEarlyExitBoundaryContact: true,
  })
  expect(result).toHaveLength(1)
  expect(result[0]).toHaveLength(1)
  const plan = result[0]![0]!
  expect(plan.via!.center).toEqual(viaPoint)
  expect(plan.exitPoint).toEqual(exitPoint)
  expect(
    plan.segments.some((segment) =>
      [segment.start, segment.end].some(touchesEarly),
    ),
  ).toBe(false)
  expect(plan.length).toBeCloseTo(before.length, 7)
  for (const [index, segment] of plan.segments.entries()) {
    const dx = segment.end.x - segment.start.x,
      dy = segment.end.y - segment.start.y
    expect(
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ),
    ).toBeLessThan(1e-7)
    const next = plan.segments[index + 1]
    if (next?.layer === segment.layer) {
      const nx = next.end.x - next.start.x,
        ny = next.end.y - next.start.y
      expect(
        (dx * nx + dy * ny) / (Math.hypot(dx, dy) * Math.hypot(nx, ny)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  expect(JSON.stringify({ srj, bus, viaPoint, exitPoint })).toBe(original)
  const routedSrj = { ...srj, traces: [plan.trace] }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    issues: [],
    checkedTraceCount: 1,
    checkedViaCount: 1,
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
