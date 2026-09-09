import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { normalizeLayeredPath } from "lib/normalize-layered-path"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { repairBusLengthsWithTransitSteps } from "lib/repair-bus-lengths-with-transit"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("transit cleanup repairs complete bus skew without moving other copper or source escapes", async () => {
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
    { x: -2, y: 2.5 },
    { x: -2, y: 1 },
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
        ...(index < 2 ? [{ x: 3, y: point.y, layer: "bottom" }] : []),
      ],
    })),
    obstacles: [
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
        maxLengthSkew: 1,
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
              { x: -1.5, y: -2.4 },
              { x: 1, y: -2.4 },
              { x: 1, y: -0.5 },
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
  const steps = repairBusLengthsWithTransitSteps({
    ...rules,
    inputSrj,
    plans,
    preparedBuses,
    layerNames,
    maximumIterationsPerConnection: 500_000,
  })
  let next = steps.next()
  while (!next.done) next = steps.next()
  const repaired = next.value!
  expect(repaired).not.toBeNull()
  expect(repaired).toHaveLength(3)
  expect(JSON.stringify({ inputSrj, preparedBuses, plans })).toBe(original)
  const changed = repaired.find((plan) => plan.connectionName === "N0")!
  const old = plans.find((plan) => plan.connectionName === "N0")!
  expect(changed.length).toBeLessThan(old.length)
  expect(changed.via).toBe(old.via)
  expect(changed.exitPoint).toBe(old.exitPoint)
  expect(changed.sourcePoint).toBe(old.sourcePoint)
  expect(changed.segments[0]).toBe(old.segments[0])
  expect(changed.additionalVias!.length).toBeGreaterThanOrEqual(2)
  expect(
    changed.additionalVias!.every(
      (via) => JSON.stringify(via.spanLayers) === JSON.stringify(layerNames),
    ),
  ).toBe(true)
  expect(changed.segments.some((segment) => segment.layer === "inner1")).toBe(
    true,
  )
  expect(changed.segments.some((segment) => segment.layer === "inner2")).toBe(
    false,
  )
  for (const plan of plans.filter((plan) => plan !== old))
    expect(
      repaired.find((item) => item.connectionIndex === plan.connectionIndex),
    ).toBe(plan)
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: repaired,
    layerNames,
  })
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
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 3, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: repaired.map((plan) => plan.trace) },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 3, issues: [] })
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
  const forbidden = repairBusLengthsWithTransitSteps({
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
        ...inputSrj,
        connections: [],
        traces: repaired.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
