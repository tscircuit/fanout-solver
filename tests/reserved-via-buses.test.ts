import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("joint fixed-via routing crosses a blocked layer while preserving every source and permitted layer", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const sources = [
    { x: -2, y: -0.5 },
    { x: -2, y: 1 },
  ]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((point, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...point, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        ...(i === 0 ? [{ x: 3, y: -0.5, layer: "bottom" }] : []),
      ],
    })),
    obstacles: [
      ...sources.map((point, i) => ({
        type: "rect" as const,
        center: point,
        width: 0.3,
        height: 0.3,
        componentId: "U1",
        obstacleId: `P${i}`,
        layers: ["top"],
        connectedTo: [`N${i}`, `P${i}`],
      })),
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 6.5,
        layers: ["bottom"],
        connectedTo: ["wall"],
      },
    ],
  }
  const allBuses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "signal",
        sourceComponentId: "U1",
        connectionNames: ["N0"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["bottom", "inner1"],
      },
      {
        busId: "plane",
        direction: "right",
        sourceComponentId: "U1",
        connectionNames: ["N1"],
        termination: { type: "plane", layer: "inner2" },
      },
    ],
  })
  const bus = allBuses.find((bus) => bus.busId === "signal")!,
    connection = bus.connections[0]!
  const fixed = new Map([
    [0, { x: -1.5, y: -0.5 }],
    [1, { x: -1.5, y: 1 }],
  ])
  const original = JSON.stringify({ srj, allBuses, fixed: [...fixed] })
  const params = {
    ...rules,
    srj,
    allBuses,
    buses: [bus],
    targetLayer: "bottom",
    transitLayers: ["inner1"],
    layerNames,
    fixedViaPointsByConnectionIndex: fixed,
    acceptedPlans: [],
    terminals: [
      { connection, viaPoint: fixed.get(0)!, exitPoint: { x: 3, y: -0.5 } },
    ],
    maximumIterations: 200_000,
  }
  const steps = routeReservedViaBusesSteps(params)
  let next = steps.next()
  while (!next.done) next = steps.next()
  const plans = next.value!
  expect(plans).not.toBeNull()
  expect(plans).toHaveLength(1)
  expect(plans[0]!.busId).toBe("signal")
  expect(plans[0]!.via!.center).toEqual(fixed.get(0)!)
  expect(plans[0]!.additionalVias!.length).toBeGreaterThanOrEqual(2)
  expect(
    plans[0]!.additionalVias!.every(
      (via) => JSON.stringify(via.spanLayers) === JSON.stringify(layerNames),
    ),
  ).toBe(true)
  expect(plans[0]!.segments.some((segment) => segment.layer === "inner1")).toBe(
    true,
  )
  expect(plans[0]!.segments.some((segment) => segment.layer === "inner2")).toBe(
    false,
  )
  for (const plan of plans)
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
      const nextSegment = plan.segments[i + 1]
      if (nextSegment?.layer !== segment.layer) continue
      const nx = nextSegment.end.x - nextSegment.start.x,
        ny = nextSegment.end.y - nextSegment.start.y
      expect(
        (dx * nx + dy * ny) / (Math.hypot(dx, dy) * Math.hypot(nx, ny)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  expect(plans[0]!.exitPoint).toEqual({ x: 3, y: -0.5 })
  expect(JSON.stringify({ srj, allBuses, fixed: [...fixed] })).toBe(original)
  const planeBus = allBuses.find((bus) => bus.busId === "plane")!,
    planeConnection = planeBus.connections[0]!,
    planeVia = fixed.get(1)!
  const prefix = buildViaMinimalWindingPlan({
    ...rules,
    layerNames,
    bus: planeBus,
    terminal: {
      connection: planeConnection,
      viaPoint: planeVia,
      exitPoint: planeVia,
    },
    targetLayer: "inner2",
    targetLayerPoints: [planeVia],
    allowBlindAndBuriedVias: false,
  })
  const routedSrj = {
    ...srj,
    traces: [...plans.map((plan) => plan.trace), prefix.trace],
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [], checkedTraceCount: 2 })
  const tightSteps = routeReservedViaBusesSteps({
    ...params,
    tightViaChannels: true,
    ripCost: 64,
    maximumRipEvents: 200,
  })
  let tight = tightSteps.next()
  while (!tight.done) tight = tightSteps.next()
  expect(tight.value).not.toBeNull()
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: {
        ...srj,
        traces: [...tight.value!.map((plan) => plan.trace), prefix.trace],
      },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [], checkedTraceCount: 2 })
  const forbidden = routeReservedViaBusesSteps({
    ...params,
    transitLayers: ["inner2"],
    maximumIterations: 10_000,
  })
  let blocked = forbidden.next()
  while (!blocked.done) blocked = forbidden.next()
  expect(blocked.value).toBeNull()
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
