import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("an intact bus crosses an internal layer before returning to its permitted source layer", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -2, maxY: 2 }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    layerNames: ["top", "inner1", "bottom"],
  }
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 3,
    minTraceWidth: rules.traceWidth,
    connections: [-0.5, 0.5].map((y, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { x: -2, y, layer: "top", pointId: `P${i}` },
        { x: 3, y, layer: "top" },
      ],
    })),
    obstacles: [
      ...[-0.5, 0.5].map((y, i) => ({
        type: "rect" as const,
        center: { x: -2, y },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        componentId: "U1",
        connectedTo: [`N${i}`, `P${i}`],
      })),
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 4,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
  const buses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "returning",
        sourceComponentId: "U1",
        connectionNames: ["N0", "N1"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["top", "inner1"],
      },
    ],
  })
  const fixed = new Map([
    [0, { x: -1.5, y: -0.5 }],
    [1, { x: -1.5, y: 0.5 }],
  ])
  const params = {
    ...rules,
    srj,
    allBuses: buses,
    buses,
    targetLayer: "top",
    startLayerByBusId: new Map([["returning", "inner1"]]),
    fixedViaPointsByConnectionIndex: fixed,
    terminals: buses[0]!.connections.map((connection) => ({
      connection,
      viaPoint: fixed.get(connection.connectionIndex)!,
      exitPoint: { x: 3, y: connection.sourcePoint.y },
    })),
    acceptedPlans: [],
    maximumIterations: 200_000,
    maximumLocalRepairAttempts: 0,
  }
  const before = JSON.stringify({ srj, buses, fixed: [...fixed] })
  const solve = (
    overrides: Partial<typeof params> & { routeFromSourcePads?: boolean } = {},
  ) => {
    const generator = routeReservedViaBusesSteps({ ...params, ...overrides })
    let step = generator.next()
    while (!step.done) step = generator.next()
    return step.value
  }
  const plans = solve()!
  expect(plans).toHaveLength(2)
  for (const plan of plans) {
    expect(plan.targetLayer).toBe("top")
    expect(plan.via).toMatchObject({
      center: fixed.get(plan.connectionIndex),
      fromLayer: "top",
      toLayer: "inner1",
      spanLayers: rules.layerNames,
    })
    expect(plan.additionalVias?.length).toBeGreaterThanOrEqual(1)
    expect(plan.additionalVias?.at(-1)).toMatchObject({
      toLayer: "top",
      spanLayers: rules.layerNames,
    })
    expect(plan.segments.some((segment) => segment.layer === "inner1")).toBe(
      true,
    )
    expect(plan.trace.route.at(-1)).toMatchObject({
      route_type: "wire",
      x: 3,
      y: plan.connectionIndex === 0 ? -0.5 : 0.5,
      layer: "top",
    })
    for (let i = 0; i < plan.segments.length; i++) {
      const segment = plan.segments[i]!,
        dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const next = plan.segments[i + 1]
      if (next?.layer === segment.layer)
        expect(
          (dx * (next.end.x - next.start.x) +
            dy * (next.end.y - next.start.y)) /
            (Math.hypot(dx, dy) *
              Math.hypot(next.end.x - next.start.x, next.end.y - next.start.y)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const output = { ...srj, traces: plans.map((plan) => plan.trace) }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [], checkedTraceCount: 2 })
  expect(solve({ startLayerByBusId: undefined })).toBeNull()
  expect(solve({ startLayerByBusId: new Map() })).toBeNull()
  expect(
    solve({ startLayerByBusId: new Map([["returning", "top"]]) }),
  ).toBeNull()
  expect(
    solve({ startLayerByBusId: new Map([["returning", "bottom"]]) }),
  ).toBeNull()
  expect(solve({ routeFromSourcePads: true })).toBeNull()
  expect(JSON.stringify({ srj, buses, fixed: [...fixed] })).toBe(before)
  await expect(
    getSvgFromGraphicsObject(visualizeSimpleRouteJson(output)),
  ).toMatchSvgSnapshot(import.meta.path)
})
