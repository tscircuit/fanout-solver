import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import {
  routeReservedViaBusesSteps,
  completeSourceOriginBusSteps,
} from "lib/route-reserved-via-buses"
import { prepareSourceOriginReservations } from "lib/route-source-origin-buses"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("finishes one missing source-origin lane without exposing a partial bus or changing retained sources", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const sources = [
    { x: 1, y: -1.5 },
    { x: -2, y: 0 },
    { x: -2, y: 2.3 },
  ]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((point, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...point, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        ...(i < 2 ? [{ x: 3, y: point.y, layer: "bottom" }] : []),
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
        layers: ["top", "bottom"],
        connectedTo: ["wall"],
      },
    ],
  }
  const allBuses = prepareFanoutBuses(srj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "signals",
        sourceComponentId: "U1",
        connectionNames: ["N0", "N1"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["inner1", "bottom"],
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
  const source = prepareSourceOriginReservations({
    ...rules,
    srj,
    buses: allBuses,
    layerNames,
  })!
  expect(source).not.toBeNull()
  const bus = allBuses.find((bus) => bus.busId === "signals")!
  const params = {
    ...rules,
    srj,
    allBuses,
    buses: [bus],
    targetLayer: "bottom",
    layerNames,
    ...source,
    acceptedPlans: [],
    routeFromSourcePads: true,
    sourceLayerTravelCost: 2,
    maximumIterations: 300_000,
    shuffleSeed: 1,
    terminals: bus.connections.map((connection) => ({
      connection,
      viaPoint: source.fixedViaPointsByConnectionIndex.get(
        connection.connectionIndex,
      )!,
      exitPoint: { x: 3, y: connection.targetPoint.y },
    })),
  }
  const before = JSON.stringify({
    srj,
    allBuses,
    source,
    sites: [...source.fixedViaPointsByConnectionIndex],
    paths: [...source.sourceEscapePaths],
  })
  const consume = (
    transitLayers: string[],
    maximumSourceOriginRepairAttempts = 0,
  ) => {
    const steps = routeReservedViaBusesSteps({
      ...params,
      transitLayers,
      maximumSourceOriginRepairAttempts,
    })
    let next = steps.next()
    while (!next.done) next = steps.next()
    return next.value
  }
  expect(consume([])).toBeNull()
  // The plane layer is present on the board but is forbidden to these signals.
  expect(consume(["inner2"])).toBeNull()
  const first = routeReservedViaBusesSteps({
    ...params,
    buses: [{ ...bus, connections: bus.connections.slice(0, 1) }],
    terminals: params.terminals.slice(0, 1),
  })
  let firstResult = first.next()
  while (!firstResult.done) firstResult = first.next()
  expect(firstResult.value).toHaveLength(1)
  const partial = firstResult.value!
  const beforePartial = structuredClone(partial)
  const forbiddenCompletion = completeSourceOriginBusSteps(
    {
      ...params,
      buses: [
        { ...bus, allowedLayers: ["bottom"], routableEscapeLayers: ["bottom"] },
      ],
    },
    partial,
  )
  let forbidden = forbiddenCompletion.next()
  while (!forbidden.done) forbidden = forbiddenCompletion.next()
  expect(forbidden.value).toBeNull()
  expect(partial).toEqual(beforePartial)
  const completion = completeSourceOriginBusSteps(params, partial)
  let next = completion.next()
  while (!next.done) next = completion.next()
  const signals = next.value!
  expect(partial).toEqual(beforePartial)
  expect(
    signals?.find((p) => p.connectionIndex === partial[0]!.connectionIndex),
  ).toBe(partial[0])
  expect(signals).not.toBeNull()
  expect(signals).toHaveLength(2)
  for (const plan of signals) {
    expect(plan.targetLayer).toBe("bottom")
    expect(plan.via!.fromLayer).toBe("top")
    expect(["bottom", "inner1"]).toContain(plan.via!.toLayer)
    if (plan.connectionName === "N1") {
      expect(plan.additionalVias!.length).toBeGreaterThanOrEqual(1)
      expect(plan.additionalVias!.at(-1)).toMatchObject({
        fromLayer: "inner1",
        toLayer: "bottom",
        spanLayers: layerNames,
      })
      expect(
        plan.segments.some(
          (s) => s.layer === "inner1" && s.start.x * s.end.x < 0,
        ),
      ).toBe(true)
    }
    expect(plan.segments.some((s) => s.layer === "inner2")).toBe(false)
    for (const [index, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const previous = plan.segments[index - 1]
      if (previous?.layer === segment.layer) {
        const px = previous.end.x - previous.start.x,
          py = previous.end.y - previous.start.y
        const length = Math.hypot(dx, dy) * Math.hypot(px, py)
        if (length > 1e-12)
          expect((px * dx + py * dy) / length).toBeGreaterThanOrEqual(
            Math.SQRT1_2 - 1e-7,
          )
      }
    }
  }
  const plans = [
    ...signals,
    ...source.sourcePlans.filter((plan) => plan.termination.type === "plane"),
  ]
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
      preparedBuses: allBuses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedConnectionCount: 3,
    brokenOutConnectionCount: 3,
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
  expect(
    JSON.stringify({
      srj,
      allBuses,
      source,
      sites: [...source.fixedViaPointsByConnectionIndex],
      paths: [...source.sourceEscapePaths],
    }),
  ).toBe(before)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
