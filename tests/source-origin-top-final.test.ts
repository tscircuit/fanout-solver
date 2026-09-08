import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { prepareSourceOriginReservations } from "lib/route-source-origin-buses"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("TOP-final source-origin buses use real separated through-vias despite a clear via-free shortcut", async () => {
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
    { x: -2, y: 0.5 },
    { x: -2, y: 1.5 },
  ]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((point, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...point, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        ...(i < 2 ? [{ x: 3, y: point.y, layer: "top" }] : []),
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
        allowedLayers: ["top", "inner1"],
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
    targetLayer: "top",
    layerNames,
    ...source,
    acceptedPlans: [],
    routeFromSourcePads: true,
    sourceLayerTravelCost: 2,
    maximumIterations: 300_000,
    terminals: bus.connections.map((connection) => ({
      connection,
      viaPoint: source.fixedViaPointsByConnectionIndex.get(
        connection.connectionIndex,
      )!,
      exitPoint: { x: 3, y: connection.targetPoint.y },
    })),
  }
  const before = JSON.stringify({ srj, allBuses, source })
  const consume = (
    transitLayers: string[],
    allowSourceOriginTopFinal = true,
    overrides: Partial<Parameters<typeof routeReservedViaBusesSteps>[0]> = {},
  ) => {
    const steps = routeReservedViaBusesSteps({
      ...params,
      transitLayers,
      allowSourceOriginTopFinal,
      ...overrides,
    })
    let next = steps.next()
    while (!next.done) next = steps.next()
    return next.value
  }
  expect(consume(["inner1"], false)).toBeNull()
  expect(consume([])).toBeNull()
  // The plane layer is present on the board but is forbidden to these signals.
  expect(consume(["inner2"])).toBeNull()
  // A copied selected bus cannot widen the original bus's layer permission.
  expect(
    consume(["inner1"], true, {
      allBuses: allBuses.map((original) =>
        original.busId === bus.busId
          ? {
              ...original,
              allowedLayers: ["inner1"],
              routableEscapeLayers: ["inner1"],
            }
          : original,
      ),
    }),
  ).toBeNull()
  expect(
    consume(["inner1"], true, {
      buses: [{ ...bus, connections: bus.connections.slice(0, 1) }],
      terminals: params.terminals.slice(0, 1),
    }),
  ).toBeNull()
  const signals = consume(["inner1"])!
  expect(signals).not.toBeNull()
  expect(signals).toHaveLength(2)
  for (const plan of signals) {
    expect(plan.targetLayer).toBe("top")
    expect(plan.via!.fromLayer).toBe("top")
    expect(plan.via!.toLayer).toBe("inner1")
    expect(plan.additionalVias!.length).toBeGreaterThanOrEqual(1)
    expect(plan.additionalVias!.at(-1)).toMatchObject({
      fromLayer: "inner1",
      toLayer: "top",
      spanLayers: layerNames,
    })
    expect(
      plan.segments.some(
        (s) =>
          s.layer === "inner1" &&
          Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > 1e-7,
      ),
    ).toBe(true)
    const returned = plan.additionalVias!.find((via) => via.toLayer === "top")!
    expect(
      Math.hypot(
        returned.center.x - plan.via!.center.x,
        returned.center.y - plan.via!.center.y,
      ),
    ).toBeGreaterThanOrEqual(rules.viaDiameter + rules.clearance - 1e-9)
    expect(
      plan.segments.some((s) => s.layer === "inner2" || s.layer === "bottom"),
    ).toBe(false)
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
  expect(JSON.stringify({ srj, allBuses, source })).toBe(before)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
