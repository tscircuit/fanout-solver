import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { getExitEdgeForDirection } from "lib/boundary-exit"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeMultiEdgeReservedBusesSteps } from "lib/route-multi-edge-reserved-buses"
import { prepareSourceOriginReservations } from "lib/route-source-origin-buses"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("routes every connected BGA pad with atomic multi-edge groups and retained plane sources", async () => {
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
  const points = Array.from({ length: 16 }, (_, i) => ({
    x: ((i % 4) - 1.5) * 0.8,
    y: (Math.floor(i / 4) - 1.5) * 0.8,
  }))
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: layerNames.length,
    minTraceWidth: rules.traceWidth,
    connections: points.map((point, i) => {
      const side = sides.find((side) => side.indices.includes(i))
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
        allowedLayers: ["top", "inner2", "inner3", "bottom"],
        maxLengthSkew: 2,
      })),
      ...points.flatMap((_, i) =>
        sides.some((side) => side.indices.includes(i))
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
  for (const bus of buses) {
    const own = plans.filter((plan) => plan.busId === bus.busId)
    expect(own).toHaveLength(bus.connections.length)
    expect(new Set(own.map((plan) => plan.targetLayer)).size).toBe(1)
    expect(own.every((plan) => plan.via)).toBe(true)
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
