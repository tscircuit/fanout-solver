import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { rerouteBusWithRetainedBoundaryTailsSteps } from "lib/reroute-bus-with-retained-boundary-tails"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("retained boundary tails jointly repair neighboring buses without moving source or supplied copper", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.12,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const sources = [
    { x: -2, y: -0.5 },
    { x: -2, y: 2.4 },
    { x: -2, y: 1 },
    { x: -2, y: 1.95 },
    { x: -2, y: 2.85 },
  ]
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((point, index) => ({
      name: `N${index}`,
      pointsToConnect: [
        {
          ...point,
          layer: "top",
          pointId: `P${index}`,
          pcb_port_id: `P${index}`,
        },
        ...(index !== 2 ? [{ x: 3, y: point.y, layer: "bottom" }] : []),
      ],
    })),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "preserved-trace",
        connection_name: "N2",
        route: [
          {
            route_type: "wire",
            x: -0.5,
            y: -2.85,
            layer: "top",
            width: rules.traceWidth,
          },
          {
            route_type: "wire",
            x: -0.2,
            y: -2.85,
            layer: "top",
            width: rules.traceWidth,
          },
          {
            route_type: "via",
            x: -0.2,
            y: -2.85,
            from_layer: "top",
            to_layer: "bottom",
            via_diameter: rules.viaDiameter,
            via_hole_diameter: rules.viaHoleDiameter,
          },
          {
            route_type: "wire",
            x: -0.2,
            y: -2.85,
            layer: "bottom",
            width: rules.traceWidth,
          },
          {
            route_type: "wire",
            x: 0.1,
            y: -2.85,
            layer: "bottom",
            width: rules.traceWidth,
          },
        ],
      },
    ],
    obstacles: [
      {
        type: "rect",
        center: { x: 2, y: 0.5 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [],
      },
      ...sources.map((point, index) => ({
        type: "rect" as const,
        center: point,
        width: 0.3,
        height: 0.3,
        componentId: "U1",
        obstacleId: `P${index}`,
        layers: ["top"],
        connectedTo: [`N${index}`, `P${index}`],
      })),
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 3.6,
        layers: ["bottom"],
        connectedTo: ["wall"],
      },
      {
        type: "rect",
        center: { x: 2.75, y: -0.5 },
        width: 0.2,
        height: 0.4,
        layers: ["bottom"],
        connectedTo: ["terminal-wall"],
      },
    ],
  }
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "data",
        sourceComponentId: "U1",
        connectionNames: ["N0", "N1"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["bottom", "inner1"],
        maxLengthSkew: 1.5,
      },
      {
        busId: "neighbor",
        sourceComponentId: "U1",
        connectionNames: ["N3", "N4"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["bottom", "inner1"],
        maxLengthSkew: 1.5,
      },
      {
        busId: "plane",
        sourceComponentId: "U1",
        connectionNames: ["N2"],
        direction: "right",
        termination: { type: "plane", layer: "inner2" },
      },
    ],
  })
  for (const bus of preparedBuses)
    if (bus.termination.type === "boundary") bus.exitEdge = "right"
  const plans = preparedBuses.flatMap((bus) =>
    bus.connections.map((connection) => {
      const viaPoint = { x: -1.5, y: connection.sourcePoint.y }
      const plane = bus.termination.type === "plane"
      const targetLayer = plane ? "inner2" : "bottom"
      const exitPoint = plane ? viaPoint : { x: 3, y: viaPoint.y }
      const points =
        connection.connection.name === "N0"
          ? [
              viaPoint,
              { x: -2.5, y: -1.5 },
              { x: -2.5, y: -2.4 },
              { x: 2.97968, y: -2.4 },
              { x: 2.97968, y: -0.52032 },
              exitPoint,
            ]
          : plane
            ? [viaPoint]
            : [viaPoint, exitPoint]
      const normalized =
        points.length > 1
          ? normalizeLayeredPath({
              points: points.map((point) => ({
                ...point,
                z: layerNames.indexOf(targetLayer),
              })),
              chamfer: rules.traceWidth / 4,
              segmentIsClear: () => true,
            })!
          : points
      return buildViaMinimalWindingPlan({
        ...rules,
        layerNames,
        bus,
        terminal: { connection, viaPoint, exitPoint },
        targetLayer,
        targetLayerPoints: normalized,
        allowBlindAndBuriedVias: false,
      })
    }),
  )
  const original = JSON.stringify({ inputSrj, preparedBuses, plans })
  const before = validateFanoutSolution({
    inputSrj,
    outputSrj: buildOutputSimpleRouteJson({ inputSrj, plans, layerNames }),
    plans,
    preparedBuses,
    sharedBoundary: bounds,
    clearance: rules.clearance,
    allowBlindAndBuriedVias: false,
  })
  expect(before.issues.map((issue) => issue.code)).toEqual(["bus-length-skew"])
  const steps = rerouteBusWithRetainedBoundaryTailsSteps({
    ...rules,
    inputSrj,
    plans,
    preparedBuses,
    layerNames,
    maximumIterationsPerAttempt: 500_000,
  })
  let next = steps.next()
  const phases = new Set<string>()
  while (!next.done) {
    phases.add(next.value.phase)
    next = steps.next()
  }
  expect(phases.has("bus")).toBe(true)
  expect(phases.has("layer")).toBe(true)
  const repaired = next.value!
  expect(repaired).not.toBeNull()
  expect(repaired).toHaveLength(5)
  expect(JSON.stringify({ inputSrj, preparedBuses, plans })).toBe(original)
  for (const previous of plans) {
    const current = repaired.find(
      (plan) => plan.connectionIndex === previous.connectionIndex,
    )!
    expect(current.sourcePoint).toBe(previous.sourcePoint)
    expect(current.via).toBe(previous.via)
    expect(current.exitPoint).toBe(previous.exitPoint)
    for (
      let index = 0;
      index < (previous.sourceEscapeSegmentCount ?? 1);
      index++
    )
      expect(current.segments[index]).toBe(previous.segments[index])
    const lastSourcePoint = previous.trace.route.findIndex(
      (point) => point.route_type === "via",
    )
    for (let index = 0; index <= lastSourcePoint; index++)
      expect(current.trace.route[index]).toBe(previous.trace.route[index])
  }
  const changed = repaired.find((plan) => plan.connectionName === "N0")!
  const old = plans.find((plan) => plan.connectionName === "N0")!
  expect(changed.length).toBeLessThan(old.length)
  expect(changed.via).toEqual(old.via)
  expect(changed.exitPoint).toEqual(old.exitPoint)
  expect(changed.sourcePoint).toEqual(old.sourcePoint)
  expect(changed.segments[0]).toEqual(old.segments[0])
  expect(changed.additionalVias).toHaveLength(0)
  expect(
    changed.additionalVias!.every(
      (via) => JSON.stringify(via.spanLayers) === JSON.stringify(layerNames),
    ),
  ).toBe(true)
  expect(
    changed.segments
      .slice(changed.sourceEscapeSegmentCount ?? 1)
      .every((segment) => ["bottom", "inner1"].includes(segment.layer)),
  ).toBe(true)
  expect(changed.segments.some((segment) => segment.layer === "inner2")).toBe(
    false,
  )
  for (const plan of plans.filter((plan) => plan.busId === "plane"))
    expect(
      repaired.find((item) => item.connectionIndex === plan.connectionIndex),
    ).toBe(plan)
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: repaired,
    layerNames,
  })
  expect(outputSrj.traces).toContainEqual(inputSrj.traces![0]!)
  for (const oldPlan of plans) {
    const current = repaired.find(
      (p) => p.connectionIndex === oldPlan.connectionIndex,
    )!
    expect(current.via).toEqual(oldPlan.via)
    expect(current.exitPoint).toEqual(oldPlan.exitPoint)
    expect(
      current.segments.slice(0, current.sourceEscapeSegmentCount ?? 1),
    ).toEqual(oldPlan.segments.slice(0, oldPlan.sourceEscapeSegmentCount ?? 1))
  }
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans: repaired,
      preparedBuses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 5, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: {
        ...inputSrj,
        traces: [...inputSrj.traces!, ...repaired.map((plan) => plan.trace)],
      },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 6, issues: [] })
  for (const plan of repaired)
    for (let index = 0; index < plan.segments.length; index++) {
      const segment = plan.segments[index]!,
        dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const other = plan.segments[index + 1]
      if (other?.layer !== segment.layer) continue
      const nx = other.end.x - other.start.x,
        ny = other.end.y - other.start.y
      expect(
        (dx * nx + dy * ny) / (Math.hypot(dx, dy) * Math.hypot(nx, ny)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  const forbidden = rerouteBusWithRetainedBoundaryTailsSteps({
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
    layerNames,
  })
  let blocked = forbidden.next()
  while (!blocked.done) blocked = forbidden.next()
  expect(blocked.value).toBeNull()
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...outputSrj,
        connections: [],
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
