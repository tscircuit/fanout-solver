import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { distance, distancePointToSegment } from "lib/geometry"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("off-grid packed terminals retain perpendicular approaches and all fixed source copper", async () => {
  const bounds = { minX: -1.5, maxX: 1.5, minY: -1.5, maxY: 1.5 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const pitch = rules.traceWidth + rules.clearance
  const layerNames = ["top", "inner1", "bottom"]
  const sources = [-0.65, 0, 0.65, 1.2].map((y) => ({ x: -0.8, y }))
  const exits = [-1, 0, 1].map((i) => ({
    x: bounds.maxX,
    y: -0.00874 + i * pitch,
  }))
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: layerNames.length,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((source, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...source, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        ...(i < 3 ? [{ ...exits[i]!, layer: "bottom" }] : []),
      ],
    })),
    obstacles: sources.map((center, i) => ({
      type: "rect",
      center,
      width: 0.2,
      height: 0.2,
      componentId: "U1",
      obstacleId: `P${i}`,
      layers: ["top"],
      connectedTo: [`N${i}`, `P${i}`],
    })),
  }
  const allBuses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "data",
        connectionNames: ["N0", "N1", "N2"],
        direction: "right",
        preferredExit: "right",
        sourceComponentId: "U1",
        allowedLayers: ["bottom"],
      },
      {
        busId: "plane",
        connectionNames: ["N3"],
        direction: "right",
        sourceComponentId: "U1",
        termination: { type: "plane", layer: "inner1" },
      },
    ],
  })
  const bus = allBuses.find((bus) => bus.busId === "data")!
  const fixed = new Map(
    sources.map((source, i) => [i, { x: -0.4, y: source.y }]),
  )
  const params = {
    ...rules,
    srj,
    allBuses,
    buses: [bus],
    targetLayer: "bottom",
    layerNames,
    fixedViaPointsByConnectionIndex: fixed,
    acceptedPlans: [],
    terminals: bus.connections.map((connection) => ({
      connection,
      viaPoint: fixed.get(connection.connectionIndex)!,
      exitPoint: exits[connection.connectionIndex]!,
    })),
    terminalApproachLength: 2 * pitch,
    tightViaChannels: true,
    maximumIterations: 200_000,
    maximumLocalRepairAttempts: 0,
  }
  const original = JSON.stringify({
    srj,
    allBuses,
    fixed: [...fixed],
    terminals: params.terminals,
  })
  const direct = routeReservedViaBusesSteps({
    ...params,
    terminalApproachLength: undefined,
    srj: {
      ...srj,
      traces: exits.map((exit, i) => ({
        type: "pcb_trace",
        pcb_trace_id: `approach-${i}`,
        connection_name: `N${i}`,
        route: [
          { x: exit.x - params.terminalApproachLength, y: exit.y },
          exit,
        ].map((point) => ({
          ...point,
          route_type: "wire",
          layer: "bottom",
          width: rules.traceWidth,
        })),
      })),
    },
  })
  let withoutEntries = direct.next()
  while (!withoutEntries.done) withoutEntries = direct.next()
  expect(withoutEntries.value).toBeNull()
  const run = routeReservedViaBusesSteps(params)
  let result = run.next()
  while (!result.done) result = run.next()
  expect(result.value).not.toBeNull()
  const plans = result.value!
  expect(plans).toHaveLength(3)
  for (const plan of plans) {
    expect(plan.busId).toBe(bus.busId)
    expect(plan.via!.center).toEqual(fixed.get(plan.connectionIndex)!)
    expect(plan.additionalVias ?? []).toHaveLength(0)
    expect(plan.sourceObstacle).toBe(
      bus.connections.find((c) => c.connectionIndex === plan.connectionIndex)!
        .sourceObstacle,
    )
    expect(plan.segments[0]!.start).toMatchObject(
      sources[plan.connectionIndex]!,
    )
    expect(plan.exitPoint).toEqual(exits[plan.connectionIndex]!)
    const last = plan.segments.at(-1)!
    expect(last.layer).toBe("bottom")
    expect(
      distancePointToSegment(
        { x: bounds.maxX - params.terminalApproachLength, y: plan.exitPoint.y },
        last.start,
        last.end,
      ),
    ).toBeLessThan(1e-7)
    for (let i = 0; i < plan.segments.length; i++) {
      const segment = plan.segments[i]!
      const dx = segment.end.x - segment.start.x
      const dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      for (const point of [segment.start, segment.end]) {
        expect(point.x).toBeLessThanOrEqual(bounds.maxX + 1e-7)
        if (Math.abs(point.x - bounds.maxX) < 1e-7)
          expect(distance(point, plan.exitPoint)).toBeLessThan(1e-7)
      }
      const next = plan.segments[i + 1]
      if (!next || next.layer !== segment.layer) continue
      const nx = next.end.x - next.start.x
      const ny = next.end.y - next.start.y
      expect(
        (dx * nx + dy * ny) / (Math.hypot(dx, dy) * Math.hypot(nx, ny)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const planeBus = allBuses.find((bus) => bus.busId === "plane")!
  const plane = buildViaMinimalWindingPlan({
    ...rules,
    layerNames,
    bus: planeBus,
    targetLayer: "inner1",
    allowBlindAndBuriedVias: false,
    terminal: {
      connection: planeBus.connections[0]!,
      viaPoint: fixed.get(3)!,
      exitPoint: fixed.get(3)!,
    },
    targetLayerPoints: [fixed.get(3)!],
  })
  const routedSrj = {
    ...srj,
    traces: [...plans.map((plan) => plan.trace), plane.trace],
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [], checkedTraceCount: 4 })
  const fromPads = routeReservedViaBusesSteps({
    ...params,
    routeFromSourcePads: true,
  })
  let origin = fromPads.next()
  while (!origin.done) origin = fromPads.next()
  expect(origin.value).not.toBeNull()
  expect(origin.value).toHaveLength(3)
  for (const plan of origin.value!) {
    expect(plan.segments[0]!.start).toMatchObject(
      sources[plan.connectionIndex]!,
    )
    expect(plan.exitPoint).toEqual(exits[plan.connectionIndex]!)
    expect(plan.segments.at(-1)!.layer).toBe("bottom")
    expect(
      distancePointToSegment(
        { x: bounds.maxX - params.terminalApproachLength, y: plan.exitPoint.y },
        plan.segments.at(-1)!.start,
        plan.segments.at(-1)!.end,
      ),
    ).toBeLessThan(1e-7)
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: {
        ...srj,
        traces: [...origin.value!.map((plan) => plan.trace), plane.trace],
      },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [], checkedTraceCount: 4 })
  expect(
    JSON.stringify({
      srj,
      allBuses,
      fixed: [...fixed],
      terminals: params.terminals,
    }),
  ).toBe(original)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
