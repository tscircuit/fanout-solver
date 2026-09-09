import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { repairPairLengthsWithSourceTransitSteps } from "lib/repair-pair-lengths-with-source-transit"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("a mismatched pair uses permitted transit while completed copper and plane drops stay fixed", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    layerNames: ["top", "inner1", "inner2", "bottom"],
  }
  const ys = [-0.5, 0.5, 1.5, -2.3]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: ys.map((y, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { x: -2, y, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        ...(i === 2 ? [] : [{ x: 3, y, layer: "bottom" }]),
      ],
    })),
    obstacles: [
      ...ys.map((y, i) => ({
        type: "rect" as const,
        center: { x: -2, y },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        componentId: "U1",
        connectedTo: [`N${i}`, `P${i}`],
      })),
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 2,
        layers: ["top", "bottom"],
        connectedTo: ["wall"],
      },
    ],
  }
  const buses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "pair",
        sourceComponentId: "U1",
        connectionNames: ["N0", "N1"],
        direction: "right",
        preferredExit: "right",
        exitEdge: "right",
        allowedLayers: ["top", "inner1", "bottom"],
        maxLengthSkew: 0.25,
      },
      {
        busId: "plane",
        direction: "right",
        sourceComponentId: "U1",
        connectionNames: ["N2"],
        termination: { type: "plane", layer: "inner2" },
      },
      {
        busId: "retained",
        sourceComponentId: "U1",
        connectionNames: ["N3"],
        direction: "right",
        preferredExit: "right",
        exitEdge: "right",
        allowedLayers: ["bottom"],
      },
    ],
  })
  const plans = buses.flatMap((bus) =>
    bus.connections.map((connection) => {
      const i = connection.connectionIndex,
        y = ys[i]!,
        via = { x: -1.5, y },
        targetLayer = i === 2 ? "inner2" : "bottom"
      const detour = i === 0 ? -1.5 : 2.5,
        sign = i === 0 ? -1 : 1
      const points =
        i < 2
          ? [
              via,
              { x: -1, y },
              { x: -0.6, y: y + sign * 0.4 },
              { x: -0.6, y: detour - sign * 0.2 },
              { x: -0.4, y: detour },
              { x: 0.4, y: detour },
              { x: 0.6, y: detour - sign * 0.2 },
              { x: 0.6, y: y + sign * 0.4 },
              { x: 1, y },
              { x: 3, y },
            ]
          : i === 2
            ? [via]
            : [via, { x: 3, y }]
      return buildViaMinimalWindingPlan({
        ...rules,
        allowBlindAndBuriedVias: false,
        bus,
        terminal: { connection, viaPoint: via, exitPoint: points.at(-1)! },
        targetLayer,
        targetLayerPoints: points,
        sourceEscapePoints: [connection.sourcePoint, via],
      })
    }),
  )
  const original = JSON.stringify({ srj, plans })
  const pair = buses.find((b) => b.busId === "pair")!
  const own = plans.filter((p) => p.busId === "pair")
  expect(Math.abs(own[0]!.length - own[1]!.length)).toBeGreaterThan(0.25)
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: { ...srj, traces: plans.map((p) => p.trace) },
      clearance: rules.clearance,
    }).valid,
  ).toBe(true)
  const generator = repairPairLengthsWithSourceTransitSteps({
    ...rules,
    inputSrj: srj,
    plans,
    preparedBuses: buses,
    bus: pair,
  })
  let step = generator.next()
  while (!step.done) step = generator.next()
  expect(step.value).not.toBeNull()
  const repaired = step.value!
  expect(repaired).toHaveLength(4)
  for (const p of plans.filter((p) => p.busId !== "pair"))
    expect(repaired.find((q) => q.connectionIndex === p.connectionIndex)).toBe(
      p,
    )
  const changed = repaired.filter((p) => p.busId === "pair")
  expect(Math.abs(changed[0]!.length - changed[1]!.length)).toBeLessThanOrEqual(
    0.250001,
  )
  expect(Math.max(...changed.map((p) => p.length))).toBeLessThan(
    Math.max(...own.map((p) => p.length)),
  )
  expect(
    changed.some((p) => p.segments.some((s) => s.layer === "inner1")),
  ).toBe(true)
  expect(
    changed.every(
      (p) => p.targetLayer === "bottom" && p.via && p.additionalVias?.length,
    ),
  ).toBe(true)
  const normalized = normalizeFanoutPlanCorners({
    ...rules,
    inputSrj: srj,
    plans: repaired,
    preparedBuses: buses,
  })!
  expect(normalized).not.toBeNull()
  for (const p of normalized)
    for (let i = 0; i < p.segments.length; i++) {
      const s = p.segments[i]!,
        dx = s.end.x - s.start.x,
        dy = s.end.y - s.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const next = p.segments[i + 1]
      if (next?.layer === s.layer)
        expect(
          (dx * (next.end.x - next.start.x) +
            dy * (next.end.y - next.start.y)) /
            (Math.hypot(dx, dy) *
              Math.hypot(next.end.x - next.start.x, next.end.y - next.start.y)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: normalized,
    layerNames: rules.layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans: normalized,
      preparedBuses: buses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 4, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(JSON.stringify({ srj, plans })).toBe(original)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
