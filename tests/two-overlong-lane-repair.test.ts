import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { rerouteTwoOverlongLanesSteps } from "lib/reroute-bus-with-retained-boundary-tails"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("two overlong bus lanes share permitted transit while every first via and other source stays fixed", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames: ["top", "inner1", "inner2", "bottom"],
  }
  const sources = [-0.5, 0.5, 2.4, -2.7].map((y) => ({ x: -2, y }))
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((p, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...p, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        ...(i < 3 ? [{ x: 3, y: p.y, layer: "bottom" }] : []),
      ],
    })),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "supplied",
        connection_name: "N3",
        route: [
          {
            route_type: "wire",
            x: 0.5,
            y: -2.85,
            layer: "top",
            width: rules.traceWidth,
          },
          {
            route_type: "wire",
            x: 1,
            y: -2.85,
            layer: "top",
            width: rules.traceWidth,
          },
        ],
      },
    ],
    obstacles: [
      ...sources.map((center, i) => ({
        type: "rect" as const,
        shape: "circle" as const,
        center,
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        componentId: "U1",
        obstacleId: `P${i}`,
        connectedTo: [`N${i}`, `P${i}`],
      })),
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 3.6,
        layers: ["bottom"],
        connectedTo: ["wall"],
      },
    ],
  }
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "data",
        sourceComponentId: "U1",
        connectionNames: ["N0", "N1", "N2"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["bottom", "inner1"],
        maxLengthSkew: 1.5,
      },
      {
        busId: "plane",
        sourceComponentId: "U1",
        connectionNames: ["N3"],
        direction: "right",
        termination: { type: "plane", layer: "inner2" },
      },
    ],
  })
  for (const bus of preparedBuses)
    if (bus.termination.type === "boundary") bus.exitEdge = "right"
  const plans = preparedBuses.flatMap((bus) =>
    bus.connections.map((connection) => {
      const index = connection.connectionIndex,
        viaPoint = { x: -1.5, y: connection.sourcePoint.y },
        plane = bus.termination.type === "plane",
        targetLayer = plane ? "inner2" : "bottom",
        exitPoint = plane ? viaPoint : { x: 3, y: viaPoint.y }
      const points =
        index === 0
          ? [
              viaPoint,
              { x: -2.5, y: -1.5 },
              { x: -2.5, y: -2.4 },
              { x: 2.2, y: -2.4 },
              { x: 2.2, y: -1 },
              { x: 2.7, y: -0.5 },
              exitPoint,
            ]
          : index === 1
            ? [
                viaPoint,
                { x: -1.3, y: 0.5 },
                { x: -1, y: 0.8 },
                { x: -1, y: 2 },
                { x: 2, y: 2 },
                { x: 2, y: 1 },
                { x: 2.5, y: 0.5 },
                exitPoint,
              ]
            : plane
              ? [viaPoint]
              : [viaPoint, exitPoint]
      const normalized =
        points.length > 1
          ? normalizeLayeredPath({
              points: points.map((p) => ({
                ...p,
                z: rules.layerNames.indexOf(targetLayer),
              })),
              chamfer: rules.traceWidth / 4,
              segmentIsClear: () => true,
            })!
          : points
      return buildViaMinimalWindingPlan({
        ...rules,
        bus,
        terminal: { connection, viaPoint, exitPoint },
        targetLayer,
        targetLayerPoints: normalized,
        allowBlindAndBuriedVias: false,
      })
    }),
  )
  const before = JSON.stringify({ inputSrj, plans, preparedBuses })
  const originalOutput = buildOutputSimpleRouteJson({
    inputSrj,
    plans,
    layerNames: rules.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: originalOutput,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).issues,
  ).toEqual([])
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj: originalOutput,
      plans,
      preparedBuses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).issues.map((i) => i.code),
  ).toEqual(["bus-length-skew"])
  const steps = rerouteTwoOverlongLanesSteps({
    ...rules,
    inputSrj,
    plans,
    preparedBuses,
    maximumIterationsPerAttempt: 500_000,
  })
  let next = steps.next()
  while (!next.done) next = steps.next()
  expect(next.value).toHaveLength(4)
  expect(JSON.stringify({ inputSrj, plans, preparedBuses })).toBe(before)
  const repaired = next.value!
  expect(repaired.find((p) => p.busId === "plane")).toBe(
    plans.find((p) => p.busId === "plane"),
  )
  expect(
    repaired.some((p) => p.segments.some((s) => s.layer === "inner1")),
  ).toBe(true)
  for (const original of plans) {
    const current = repaired.find(
      (p) => p.connectionIndex === original.connectionIndex,
    )!
    expect(current.via).toBe(original.via)
    expect(current.sourcePoint).toBe(original.sourcePoint)
    expect(current.exitPoint).toBe(original.exitPoint)
    for (let i = 0; i < (original.sourceEscapeSegmentCount ?? 1); i++)
      expect(current.segments[i]).toBe(original.segments[i])
    const firstVia = original.trace.route.findIndex(
      (p) => p.route_type === "via",
    )
    for (let i = 0; i <= firstVia; i++)
      expect(current.trace.route[i]).toBe(original.trace.route[i])
    expect(
      current.additionalVias?.every(
        (v) =>
          JSON.stringify(v.spanLayers) === JSON.stringify(rules.layerNames),
      ) ?? true,
    ).toBe(true)
  }
  const normalized = normalizeFanoutPlanCorners({
    ...rules,
    inputSrj,
    plans: repaired,
    preparedBuses,
  })
  expect(normalized).toHaveLength(4)
  const output = buildOutputSimpleRouteJson({
    inputSrj,
    plans: normalized!,
    layerNames: rules.layerNames,
  })
  expect(output.traces).toContainEqual(inputSrj.traces![0]!)
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj: output,
      plans: normalized!,
      preparedBuses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).issues,
  ).toEqual([])
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).issues,
  ).toEqual([])
  const blocked = rerouteTwoOverlongLanesSteps({
    ...rules,
    inputSrj,
    plans,
    preparedBuses: preparedBuses.map((bus) =>
      bus.busId === "data"
        ? {
            ...bus,
            allowedLayers: ["bottom"],
            routableEscapeLayers: ["bottom"],
          }
        : bus,
    ),
  })
  let failed = blocked.next()
  while (!failed.done) failed = blocked.next()
  expect(failed.value).toBeNull()
  expect(JSON.stringify({ inputSrj, plans, preparedBuses })).toBe(before)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
