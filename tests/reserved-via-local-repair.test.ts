import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("bounded local repair completes a fenced bus while retaining all fixed vias and exact targets", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.2,
    viaHoleDiameter: 0.1,
  }
  const layerNames = ["top", "bottom"]
  const order = [0, 2, 1, 4, 3, 6, 5]
  const sources = order.map((_, i) => ({
    x: -2 + (i % 2) * 0.75,
    y: (Math.floor(i / 2) - 1.5) * 0.8,
  }))
  const exits = order.map((lane) => ({ x: 3, y: (lane - 3) * 0.4 }))
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 2,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((point, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...point, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        { ...exits[i]!, layer: "bottom" },
      ],
    })),
    obstacles: sources.map((point, i) => ({
      type: "rect",
      center: point,
      width: 0.2,
      height: 0.2,
      componentId: "U1",
      obstacleId: `P${i}`,
      layers: ["top"],
      connectedTo: [`N${i}`, `P${i}`],
    })),
  }
  const buses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "data",
        sourceComponentId: "U1",
        connectionNames: srj.connections.map((connection) => connection.name),
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["bottom"],
      },
    ],
  })
  const fixed = new Map(
    sources.map((point, i) => [i, { x: point.x + 0.35, y: point.y }]),
  )
  const params = {
    ...rules,
    srj,
    allBuses: buses,
    buses,
    targetLayer: "bottom",
    layerNames,
    terminals: buses[0]!.connections.map((connection, i) => ({
      connection,
      viaPoint: fixed.get(connection.connectionIndex)!,
      exitPoint: exits[i]!,
    })),
    fixedViaPointsByConnectionIndex: fixed,
    acceptedPlans: [],
    maximumIterations: 300_000,
    maximumRipEvents: 1,
    shuffleSeed: 1,
    tightViaChannels: true,
    ripCost: 64,
  }
  const original = JSON.stringify({ srj, buses, fixed: [...fixed] })
  const blocked = routeReservedViaBusesSteps({
    ...params,
    maximumLocalRepairAttempts: 0,
  })
  let before = blocked.next(),
    best = 0
  while (!before.done) {
    best = Math.max(best, before.value.routedConnectionCount)
    before = blocked.next()
  }
  expect(best).toBe(6)
  expect(before.value).toBeNull()
  const repaired = routeReservedViaBusesSteps({
    ...params,
    maximumLocalRepairAttempts: 3,
  })
  let after = repaired.next()
  while (!after.done) after = repaired.next()
  expect(after.value).not.toBeNull()
  const plans = after.value!
  expect(plans).toHaveLength(7)
  expect(new Set(plans.map((plan) => plan.connectionIndex)).size).toBe(7)
  for (const plan of plans) {
    expect(plan.busId).toBe("data")
    expect(plan.targetLayer).toBe("bottom")
    expect(plan.via!.center).toEqual(fixed.get(plan.connectionIndex)!)
    expect(plan.exitPoint).toEqual(exits[plan.connectionIndex]!)
    expect(plan.additionalVias ?? []).toHaveLength(0)
    for (const [index, segment] of plan.segments.entries()) {
      const dx = Math.abs(segment.end.x - segment.start.x),
        dy = Math.abs(segment.end.y - segment.start.y)
      expect(Math.min(dx, dy, Math.abs(dx - dy))).toBeLessThan(1e-7)
      const next = plan.segments[index + 1]
      if (next?.layer === segment.layer) {
        const ux = segment.end.x - segment.start.x,
          uy = segment.end.y - segment.start.y,
          vx = next.end.x - next.start.x,
          vy = next.end.y - next.start.y
        expect(
          (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
      }
    }
  }
  expect(JSON.stringify({ srj, buses, fixed: [...fixed] })).toBe(original)
  const routedSrj = { ...srj, traces: plans.map((plan) => plan.trace) }
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
    checkedTraceCount: 7,
    checkedViaCount: 7,
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...routedSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
