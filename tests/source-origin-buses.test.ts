import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"
import { prepareFanoutBuses } from "lib/prepare-buses"
import {
  getLayerReservedBusTargets,
  routeLayerReservedBusesSteps,
} from "lib/route-layer-reserved-buses"
import {
  prepareSourceOriginReservations,
  routeSourceOriginBusesSteps,
  shouldUseSourceOriginRouting,
} from "lib/route-source-origin-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type { FanoutBusSpec } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("a whole bus can choose first vias beyond a blocked target layer without moving other sources", async () => {
  const bounds = { minX: -4, maxX: 4, minY: -4, maxY: 4 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
  }
  const layerNames = ["top", "inner1", "inner2", "bottom"]
  const srj: SimpleRouteJson = {
    bounds,
    layerCount: 4,
    minTraceWidth: rules.traceWidth,
    connections: [],
    obstacles: [],
  }
  const buses: FanoutBusSpec[] = [],
    signals: string[] = []
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++) {
      const index = row * 4 + column,
        name = `N${index}`,
        port = `P${index}`,
        source = { x: -1.5 + (column - 1.5) * 0.65, y: (row - 1.5) * 0.65 },
        signal = column === 3
      srj.obstacles.push({
        type: "rect",
        shape: "circle",
        obstacleId: port,
        componentId: "U1",
        center: source,
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [name, port],
      } as SimpleRouteJson["obstacles"][number])
      srj.connections.push({
        name,
        pointsToConnect: [
          { ...source, layer: "top", pointId: port, pcb_port_id: port },
          ...(signal ? [{ x: 4, y: -source.y, layer: "inner2" }] : []),
        ],
      })
      if (signal) signals.push(name)
      else
        buses.push({
          busId: name,
          connectionNames: [name],
          sourceComponentId: "U1",
          direction: "right",
          termination: { type: "plane", layer: "inner1" },
        })
    }
  srj.obstacles.push({
    type: "rect",
    center: { x: 0, y: 0 },
    width: 0.2,
    height: 8.5,
    layers: ["inner2"],
    connectedTo: ["wall"],
  })
  buses.push({
    busId: "address",
    connectionNames: signals,
    sourceComponentId: "U1",
    direction: "right",
    preferredExit: "right",
    exitEdge: "right",
    allowedLayers: ["inner2"],
    maxLengthSkew: 15,
  })
  const prepared = prepareFanoutBuses(srj, {
    buses,
    sharedBoundary: bounds,
    escapeLayers: ["inner2"],
  })
  const params = { ...rules, srj, buses: prepared, layerNames }
  const initial = prepareSourceOriginReservations(params)!
  expect(initial).not.toBeNull()
  const target = getLayerReservedBusTargets(params)!,
    bus = prepared.find((b) => b.busId === "address")!
  const before = JSON.stringify({
    srj,
    prepared,
    sites: [...initial.fixedViaPointsByConnectionIndex],
    paths: [...initial.sourceEscapePaths],
    sourcePlans: initial.sourcePlans,
  })
  const routeParams = {
    ...params,
    allBuses: prepared,
    buses: [bus],
    targetLayer: "inner2",
    ...initial,
    acceptedPlans: [],
    terminals: bus.connections.map((connection) => ({
      connection,
      viaPoint: initial.fixedViaPointsByConnectionIndex.get(
        connection.connectionIndex,
      )!,
      exitPoint: target.exits.get(connection.connectionIndex)!,
    })),
    maximumIterations: 100_000,
    maximumRipEvents: 1,
    maximumLocalRepairAttempts: 0,
    tightViaChannels: true,
  }
  const fixedSteps = routeReservedViaBusesSteps(routeParams)
  let fixed = fixedSteps.next()
  while (!fixed.done) fixed = fixedSteps.next()
  expect(fixed.value).toBeNull()
  const initialSourceSteps = routeReservedViaBusesSteps({
    ...routeParams,
    routeFromSourcePads: true,
    sourceLayerTravelCost: 2,
    maximumRipEvents: 1_200,
    maximumIterations: 50_000_000,
    maximumLocalRepairAttempts: 0,
    shuffleSeed: 1,
  })
  let initialSource = initialSourceSteps.next()
  while (!initialSource.done) initialSource = initialSourceSteps.next()
  expect(initialSource.value).not.toBeNull()
  expect(
    Math.max(...initialSource.value!.map((plan) => plan.length)) -
      Math.min(...initialSource.value!.map((plan) => plan.length)),
  ).toBeLessThan(15)
  const originSteps = routeSourceOriginBusesSteps(routeParams)
  let origin = originSteps.next()
  while (!origin.done) origin = originSteps.next()
  const transaction = origin.value!
  expect(transaction).not.toBeNull()
  // A whole bus that already meets its original skew keeps its routed copper.
  expect(transaction.plans).toEqual(initialSource.value!)
  expect(transaction.fixedViaPointsByConnectionIndex).not.toBe(
    initial.fixedViaPointsByConnectionIndex,
  )
  expect(transaction.sourceEscapePaths).not.toBe(initial.sourceEscapePaths)
  expect(transaction.sourcePlans).toHaveLength(srj.connections.length)
  for (const sourcePlan of transaction.sourcePlans) {
    const index = sourcePlan.connectionIndex
    expect(sourcePlan.via!.center).toEqual(
      transaction.fixedViaPointsByConnectionIndex.get(index)!,
    )
    const path = transaction.sourceEscapePaths.get(index)!
    expect(path[0]).toEqual(sourcePlan.sourcePoint)
    expect(path.at(-1)).toEqual(sourcePlan.via!.center)
    expect(path).toEqual([
      sourcePlan.sourcePoint,
      ...sourcePlan.segments
        .slice(0, sourcePlan.sourceEscapeSegmentCount)
        .map((segment) => segment.end),
    ])
    if (sourcePlan.termination.type === "plane") {
      expect(path).toEqual(initial.sourceEscapePaths.get(index)!)
      expect(sourcePlan).toEqual(
        initial.sourcePlans.find((plan) => plan.connectionIndex === index)!,
      )
    } else {
      const routedPlan = transaction.plans.find(
        (plan) => plan.connectionIndex === index,
      )!
      expect(sourcePlan.via!.center).toEqual(routedPlan.via!.center)
    }
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: {
        ...srj,
        traces: transaction.sourcePlans.map((plan) => plan.trace),
      },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).issues,
  ).toEqual([])

  // Eligibility depends on source-field geometry, not bus or component names.
  const denseBus = {
    ...bus,
    exitEdge: "top" as const,
    connections: bus.connections.flatMap((connection, row) =>
      Array.from({ length: 4 }, (_, column) => ({
        ...connection,
        connectionIndex: row * 4 + column,
        sourcePoint: {
          ...connection.sourcePoint,
          x: connection.sourcePoint.x - column * 0.04,
          y: connection.sourcePoint.y,
        },
      })),
    ),
  }
  const densePlanes = {
    ...prepared.find((candidate) => candidate.termination.type === "plane")!,
    connections: denseBus.connections.map((connection) => ({
      ...connection,
      connectionIndex: connection.connectionIndex + 16,
    })),
  }
  expect(shouldUseSourceOriginRouting([denseBus, densePlanes], false)).toBe(
    true,
  )
  expect(
    shouldUseSourceOriginRouting(
      [{ ...denseBus, exitEdge: "right" }, densePlanes],
      false,
    ),
  ).toBe(true)
  expect(shouldUseSourceOriginRouting([denseBus, densePlanes], true)).toBe(
    false,
  )
  const steps = routeLayerReservedBusesSteps({
    ...params,
    sourceOriginRouting: true,
  })
  let next = steps.next()
  while (!next.done) next = steps.next()
  const plans = next.value!
  expect(plans).not.toBeNull()
  expect(plans).toHaveLength(srj.connections.length)
  const address = plans.filter((plan) => plan.busId === "address")
  expect(address).toHaveLength(4)
  expect(
    Math.max(...address.map((p) => p.length)) -
      Math.min(...address.map((p) => p.length)),
  ).toBeLessThanOrEqual(15 + 1e-7)
  for (const plan of plans) {
    for (const [index, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x,
        dy = segment.end.y - segment.start.y
      expect(
        Math.abs(dx) < 1e-7 ||
          Math.abs(dy) < 1e-7 ||
          Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-7,
      ).toBe(true)
      const previous = plan.segments[index - 1]
      if (!previous || previous.layer !== segment.layer) continue
      const previousDx = previous.end.x - previous.start.x,
        previousDy = previous.end.y - previous.start.y,
        lengths = Math.hypot(dx, dy) * Math.hypot(previousDx, previousDy)
      if (lengths > 1e-12)
        expect(
          (dx * previousDx + dy * previousDy) / lengths,
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
    expect(plan.via!.spanLayers).toEqual(layerNames)
    if (plan.termination.type === "plane")
      expect(plan.via!.center).toEqual(
        initial.fixedViaPointsByConnectionIndex.get(plan.connectionIndex)!,
      )
    else {
      expect(plan.via!.center.x).toBeGreaterThan(
        0.1 + rules.viaDiameter / 2 + rules.clearance - 1e-7,
      )
      expect(plan.additionalVias ?? []).toHaveLength(0)
      expect(plan.targetLayer).toBe("inner2")
      expect(plan.exitPoint).toEqual(target.exits.get(plan.connectionIndex)!)
      for (const segment of plan.segments)
        for (const point of [segment.start, segment.end])
          if (
            Math.abs(point.x - bounds.minX) < 1e-7 ||
            Math.abs(point.x - bounds.maxX) < 1e-7 ||
            Math.abs(point.y - bounds.minY) < 1e-7 ||
            Math.abs(point.y - bounds.maxY) < 1e-7
          )
            expect(
              Math.hypot(
                point.x - plan.exitPoint.x,
                point.y - plan.exitPoint.y,
              ),
            ).toBeLessThan(1e-7)
      const vias = plan.trace.route.filter(
        (point) => point.route_type === "via",
      )
      expect(vias).toHaveLength(1)
      expect(vias[0]).toMatchObject({ from_layer: "top", to_layer: "inner2" })
      const firstVia = plan.trace.route.findIndex(
        (point) => point.route_type === "via",
      )
      for (const point of plan.trace.route.slice(firstVia + 1))
        if (point.route_type === "wire") expect(point.layer).toBe("inner2")
    }
  }
  expect(
    JSON.stringify({
      srj,
      prepared,
      sites: [...initial.fixedViaPointsByConnectionIndex],
      paths: [...initial.sourceEscapePaths],
      sourcePlans: initial.sourcePlans,
    }),
  ).toBe(before)
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans,
    layerNames,
  })
  expectStraightOr45Fanout(plans.map((plan) => plan.trace))
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans,
      preparedBuses: prepared,
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
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 16,
    checkedViaCount: 16,
    issues: [],
  })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
  // This compound regression runs several routers, native DRC, and SVG rendering.
  // Allow ARM CI runtime variance without changing the benchmark deadline.
}, 30_000)
