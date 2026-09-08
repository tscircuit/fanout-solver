import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { getExitEdgeForDirection } from "lib/boundary-exit"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeMultiEdgeReservedBusesSteps } from "lib/route-multi-edge-reserved-buses"
import { prepareSourceOriginReservations } from "lib/route-source-origin-buses"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("routes intact buses jointly per edge with distinct legal layers and retained plane sources", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const layerNames = ["top", "inner1", "inner2", "inner3", "bottom"]
  const sides = [
    { edge: "left" as const, indices: [4, 8] },
    { edge: "right" as const, indices: [7, 11] },
    { edge: "top" as const, indices: [12, 15] },
    { edge: "bottom" as const, indices: [0, 3] },
  ]
  const rearLeftIndices = [5, 9]
  const points = Array.from({ length: 16 }, (_, i) => ({
    x: ((i % 4) - 1.5) * 0.8,
    y: (Math.floor(i / 4) - 1.5) * 0.8,
  }))
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: layerNames.length,
    minTraceWidth: rules.traceWidth,
    connections: points.map((point, i) => {
      const side =
        sides.find((side) => side.indices.includes(i)) ??
        (rearLeftIndices.includes(i) ? sides[0] : undefined)
      const target = side
        ? {
            ...point,
            layer: "inner2",
            ...(side.edge === "left"
              ? { x: -3 }
              : side.edge === "right"
                ? { x: 3 }
                : side.edge === "top"
                  ? { y: 3 }
                  : { y: -3 }),
          }
        : null
      return {
        name: `N${i}`,
        pointsToConnect: [
          { ...point, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
          ...(target ? [target] : []),
        ],
      }
    }),
    obstacles: points.map((point, i) => ({
      type: "rect",
      shape: "circle",
      center: point,
      width: 0.4,
      height: 0.4,
      componentId: "U1",
      obstacleId: `P${i}`,
      layers: ["top"],
      connectedTo: [`N${i}`, `P${i}`],
    })),
  }
  const buses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      ...sides.map(({ edge, indices }) => ({
        busId: edge,
        sourceComponentId: "U1",
        connectionNames: indices.map((i) => `N${i}`),
        direction:
          edge === "top"
            ? ("up" as const)
            : edge === "bottom"
              ? ("down" as const)
              : edge,
        preferredExit: edge,
        allowedLayers:
          edge === "left" ? ["inner2"] : ["top", "inner2", "inner3", "bottom"],
        maxLengthSkew: 2,
      })),
      {
        busId: "left-rear",
        sourceComponentId: "U1",
        connectionNames: rearLeftIndices.map((i) => `N${i}`),
        direction: "left",
        preferredExit: "left",
        allowedLayers: ["inner3"],
        maxLengthSkew: 2,
      },
      ...points.flatMap((_, i) =>
        sides.some((side) => side.indices.includes(i)) ||
        rearLeftIndices.includes(i)
          ? []
          : [
              {
                busId: `plane${i}`,
                sourceComponentId: "U1",
                connectionNames: [`N${i}`],
                direction: "right" as const,
                termination: { type: "plane" as const, layer: "inner1" },
              },
            ],
      ),
    ],
  })
  for (const bus of buses)
    if (bus.termination.type === "boundary")
      bus.exitEdge = getExitEdgeForDirection(bus.direction)
  const params = { ...rules, srj, buses, layerNames }
  const source = prepareSourceOriginReservations(params)!
  const original = structuredClone({ srj, buses })
  const steps = routeMultiEdgeReservedBusesSteps(params)
  let next = steps.next()
  while (!next.done) next = steps.next()
  const plans = next.value!
  expect(plans).not.toBeNull()
  expect(plans).toHaveLength(16)
  expect({ srj, buses }).toEqual(original)
  expect(
    plans
      .filter((plan) => plan.busId === "left")
      .map((plan) => plan.targetLayer),
  ).toEqual(["inner2", "inner2"])
  expect(
    plans
      .filter((plan) => plan.busId === "left-rear")
      .map((plan) => plan.targetLayer),
  ).toEqual(["inner3", "inner3"])
  for (const bus of buses) {
    const own = plans.filter((plan) => plan.busId === bus.busId)
    expect(own).toHaveLength(bus.connections.length)
    expect(new Set(own.map((plan) => plan.targetLayer)).size).toBe(1)
    expect(own.every((plan) => plan.via)).toBe(true)
    for (const plan of own) {
      for (const [index, segment] of plan.segments.entries()) {
        const dx = segment.end.x - segment.start.x
        const dy = segment.end.y - segment.start.y
        if (Math.hypot(dx, dy) < 1e-9) continue
        expect(
          Math.min(
            Math.abs(dx),
            Math.abs(dy),
            Math.abs(Math.abs(dx) - Math.abs(dy)),
          ),
        ).toBeLessThan(1e-7)
        const previous = plan.segments[index - 1]
        if (previous?.layer === segment.layer) {
          const px = previous.end.x - previous.start.x
          const py = previous.end.y - previous.start.y
          expect(
            (px * dx + py * dy) / Math.hypot(px, py) / Math.hypot(dx, dy),
          ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
        }
        for (const point of [segment.start, segment.end]) {
          expect(
            Math.max(Math.abs(point.x), Math.abs(point.y)),
          ).toBeLessThanOrEqual(3 + 1e-7)
          if (
            plan.termination.type === "boundary" &&
            Math.max(Math.abs(point.x), Math.abs(point.y)) >= 3 - 1e-7
          ) {
            expect(
              Math.hypot(
                point.x - plan.exitPoint.x,
                point.y - plan.exitPoint.y,
              ),
            ).toBeLessThan(1e-7)
          }
        }
      }
    }
    if (bus.termination.type === "plane")
      expect(own).toEqual(
        source.sourcePlans.filter((plan) => plan.busId === bus.busId),
      )
  }
  expect(
    new Set(
      plans
        .filter((plan) => plan.termination.type === "boundary")
        .map((plan) => plan.targetLayer),
    ).size,
  ).toBe(3)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: buses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 16,
    brokenOutConnectionCount: 16,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
