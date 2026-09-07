import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { LayerRoutingAttempts } from "lib/layer-routing-attempts"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { rerouteOverlongBusLanesSteps } from "lib/reroute-overlong-bus-lanes"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { shortcutFanoutPlans } from "lib/shortcut-fanout-plans"
import { sourceTransitHasMajorityCrossings } from "lib/source-transit-crossing-pressure"
import type { FanoutRoutePlan } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("a complete length-trapped bus retries permitted transit without reserving the failed copper", async () => {
  const bounds = { minX: -3.5, maxX: 3.5, minY: -3.5, maxY: 3.5 }
  const rules = {
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const sources = [-1.5, -0.5, 0.5, 1.5, -2.5].map((y) => ({ x: -2, y }))
  const inputSrj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: sources.map((point, i) => ({
      name: `N${i}`,
      pointsToConnect: [
        { ...point, layer: "top", pointId: `P${i}`, pcb_port_id: `P${i}` },
        ...(i < 4 ? [{ x: 3.5, y: -point.y, layer: "bottom" }] : []),
      ],
    })),
    obstacles: sources.map((center, i) => ({
      type: "rect",
      center,
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      componentId: "U1",
      obstacleId: `P${i}`,
      connectedTo: [`N${i}`, `P${i}`],
    })),
  }
  // Narrow bottom-layer corridors leave the four intact target-only paths
  // physically clear but prevent their short lanes from gaining enough length.
  const walls = [
    "#######################",
    "#######################",
    "#####...###############",
    "#####...###############",
    "######..###############",
    "######..###############",
    "#####..........######..",
    "#####...........####...",
    "#####...#####...###....",
    "#####..................",
    "#####..................",
    "####....########.......",
    "####...................",
    "###....................",
    "###.....####...........",
    "###.....####...........",
    "###....................",
    "###....................",
    "###....................",
    "###...................#",
    "#######################",
    "#######################",
    "#######################",
  ]
  for (const [row, cells] of walls.entries())
    for (const [column, occupied] of [...cells].entries())
      if (occupied === "#")
        inputSrj.obstacles.push({
          type: "rect",
          center: { x: -3.35 + column * 0.3, y: -3.35 + row * 0.3 },
          width: 0.3,
          height: 0.3,
          layers: ["bottom"],
          connectedTo: ["corridor-wall"],
        })
  const preparedBuses = prepareFanoutBuses(inputSrj, {
    sharedBoundary: bounds,
    buses: [
      {
        busId: "signal",
        sourceComponentId: "U1",
        connectionNames: ["N0", "N1", "N2", "N3"],
        direction: "right",
        preferredExit: "right",
        allowedLayers: ["top", "bottom"],
        maxLengthSkew: 1.74,
        connectionExitTargets: Object.fromEntries(
          sources
            .slice(0, 4)
            .map((p, i) => [`N${i}`, { x: 3.5, y: -p.y, layer: "bottom" }]),
        ),
      },
      {
        busId: "plane",
        sourceComponentId: "U1",
        connectionNames: ["N4"],
        direction: "right",
        termination: { type: "plane", layer: "inner1" },
      },
    ],
  })
  const bus = preparedBuses.find((b) => b.busId === "signal")!
  const plane = preparedBuses.find((b) => b.busId === "plane")!
  const fixed = new Map(sources.map((p, i) => [i, { x: -1.5, y: p.y }]))
  const terminals = bus.connections.map((connection) => ({
    connection,
    viaPoint: fixed.get(connection.connectionIndex)!,
    exitPoint: { x: 3.5, y: -connection.sourcePoint.y },
  }))
  const planePlan = buildViaMinimalWindingPlan({
    ...rules,
    bus: plane,
    terminal: {
      connection: plane.connections[0]!,
      viaPoint: fixed.get(4)!,
      exitPoint: fixed.get(4)!,
    },
    targetLayer: "inner1",
    layerNames,
    targetLayerPoints: [fixed.get(4)!],
    allowBlindAndBuriedVias: false,
  })
  const original = JSON.stringify({
    inputSrj,
    preparedBuses,
    fixed: [...fixed],
    planePlan,
  })
  expect(
    sourceTransitHasMajorityCrossings(
      terminals.map((t) => ({ source: t.viaPoint, target: t.exitPoint })),
    ),
  ).toBe(true)
  expect(
    sourceTransitHasMajorityCrossings(
      terminals.map((t) => ({
        source: t.viaPoint,
        target: { ...t.exitPoint, y: t.viaPoint.y },
      })),
    ),
  ).toBe(false)
  const attempts = new LayerRoutingAttempts({
    wideSingleLayer: false,
    firstRipCost: 64,
    transitLayers: [],
    allTransitLayers: ["top"],
  })
  let result: FanoutRoutePlan[] | null = null
  let failedPlans: FanoutRoutePlan[] | undefined
  for (let attempt = attempts.next(); attempt; attempt = attempts.next()) {
    const steps = routeReservedViaBusesSteps({
      ...rules,
      srj: inputSrj,
      allBuses: preparedBuses,
      buses: [bus],
      targetLayer: "bottom",
      layerNames,
      fixedViaPointsByConnectionIndex: fixed,
      acceptedPlans: [],
      terminals,
      maximumIterations: 8_000_000,
      maximumRipEvents: 400,
      maximumLocalRepairAttempts: 0,
      tightViaChannels: true,
      ...attempt,
    })
    let routed = steps.next()
    while (!routed.done) routed = steps.next()
    expect(routed.value).toHaveLength(4)
    let plans = [...routed.value!, planePlan]
    expect(
      validateRoutedCopperDrc({
        inputSrj,
        routedSrj: { ...inputSrj, traces: plans.map((p) => p.trace) },
        clearance: rules.clearance,
        allowBlindAndBuriedVias: false,
      }),
    ).toMatchObject({ valid: true, checkedTraceCount: 5, issues: [] })
    plans =
      shortcutFanoutPlans({
        ...rules,
        inputSrj,
        plans,
        preparedBuses,
        layerNames,
        allowBlindAndBuriedVias: false,
      }) ?? plans
    const cleanup = rerouteOverlongBusLanesSteps({
      ...rules,
      inputSrj,
      plans,
      preparedBuses,
      layerNames,
    })
    let shortened = cleanup.next()
    while (!shortened.done) shortened = cleanup.next()
    plans = shortened.value ?? plans
    const beforeMatching = JSON.stringify(plans)
    const matched = matchBusPlanLengths({
      ...rules,
      inputSrj,
      plans,
      preparedBuses,
      sharedBoundary: bounds,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
      allowMatchingInsideDenseBounds: true,
      allowPairLaneSpreading: true,
      maximumWorkUnits: 1_000,
    })
    expect(JSON.stringify(plans)).toBe(beforeMatching)
    if (!attempt.transitLayers.length) {
      expect(matched.plans).toBeNull()
      expect(matched.failedBus).toBe(bus)
      const failedValidation = validateFanoutSolution({
        inputSrj,
        outputSrj: buildOutputSimpleRouteJson({ inputSrj, plans, layerNames }),
        plans,
        preparedBuses,
        sharedBoundary: bounds,
        clearance: rules.clearance,
        allowBlindAndBuriedVias: false,
      })
      expect(failedValidation.valid).toBe(false)
      expect(failedValidation.issues.map((issue) => issue.code)).toEqual([
        "bus-length-skew",
      ])
      failedPlans = plans
      attempts.failed(attempt, "lengths")
      continue
    }
    expect(matched.plans).not.toBeNull()
    result = matched.plans
    break
  }
  expect(result).toHaveLength(5)
  expect(failedPlans).toHaveLength(5)
  expect(result!.find((p) => p.busId === "plane")).toBe(planePlan)
  expect(result!.some((p) => (p.additionalVias?.length ?? 0) > 0)).toBe(true)
  for (const plan of result!) {
    expect(plan.via?.center).toEqual(fixed.get(plan.connectionIndex))
    expect(plan.segments[0]!.start).toMatchObject(
      sources[plan.connectionIndex]!,
    )
    for (const segment of plan.segments) {
      const dx = Math.abs(segment.end.x - segment.start.x),
        dy = Math.abs(segment.end.y - segment.start.y)
      expect(Math.min(dx, dy, Math.abs(dx - dy))).toBeLessThan(1e-7)
    }
  }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: result!,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans: result!,
      preparedBuses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 5, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: { ...inputSrj, traces: result!.map((p) => p.trace) },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 5, issues: [] })
  expect(
    JSON.stringify({ inputSrj, preparedBuses, fixed: [...fixed], planePlan }),
  ).toBe(original)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...outputSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
