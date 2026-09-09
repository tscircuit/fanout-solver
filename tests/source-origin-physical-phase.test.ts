import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { getLayerReservedBusTargets } from "lib/route-layer-reserved-buses"
import {
  prepareSourceOriginReservations,
  routeSourceOriginBusesSteps,
} from "lib/route-source-origin-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import type { FanoutBusSpec } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("physical source phase ignores discarded provisional vias and preserves all retained copper", async () => {
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
    maxLengthSkew: 1.5,
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
  const alternateSites = new Map(initial.fixedViaPointsByConnectionIndex)
  const alternatePaths = new Map(initial.sourceEscapePaths)
  for (const connection of bus.connections) {
    const source = connection.sourcePoint
    const via = { x: 1, y: source.y + 0.335 }
    alternateSites.set(connection.connectionIndex, via)
    alternatePaths.set(connection.connectionIndex, [
      source,
      { x: source.x + 0.325, y: source.y + 0.325 },
      { x: 0.99, y: source.y + 0.325 },
      via,
    ])
  }
  const alternateSources = prepared.flatMap((owner) =>
    owner.connections.map((connection) => {
      const viaPoint = alternateSites.get(connection.connectionIndex)!
      return buildViaMinimalWindingPlan({
        ...rules,
        layerNames,
        bus: owner,
        terminal: { connection, viaPoint, exitPoint: viaPoint },
        targetLayer: owner.termination.type === "plane" ? "inner1" : "inner2",
        targetLayerPoints: [viaPoint],
        sourceEscapePoints: alternatePaths.get(connection.connectionIndex),
        allowBlindAndBuriedVias: false,
      })
    }),
  )
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: { ...srj, traces: alternateSources.map((plan) => plan.trace) },
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 16,
    checkedViaCount: 16,
    issues: [],
  })
  const run = (alternate: boolean) => {
    const steps = routeSourceOriginBusesSteps({
      ...routeParams,
      sourceOriginPhysicalGridPhase: true,
      cleanupRetainedBoundaryTails: true,
      fixedViaPointsByConnectionIndex: alternate
        ? alternateSites
        : initial.fixedViaPointsByConnectionIndex,
      sourceEscapePaths: alternate ? alternatePaths : initial.sourceEscapePaths,
      terminals: routeParams.terminals.map((terminal) => ({
        ...terminal,
        viaPoint: (alternate
          ? alternateSites
          : initial.fixedViaPointsByConnectionIndex
        ).get(terminal.connection.connectionIndex)!,
      })),
    })
    let next = steps.next()
    while (!next.done) next = steps.next()
    expect(next.value).not.toBeNull()
    return next.value!
  }
  const rawSteps = routeReservedViaBusesSteps({
    ...routeParams,
    sourceOriginPhysicalGridPhase: true,
    routeFromSourcePads: true,
    sourceLayerTravelCost: 2,
    maximumRipEvents: 1_200,
    maximumIterations: 50_000_000,
    shuffleSeed: 1,
  })
  let raw = rawSteps.next()
  while (!raw.done) raw = rawSteps.next()
  expect(raw.value).not.toBeNull()
  const skew = (plans: { length: number }[]) =>
    Math.max(...plans.map((plan) => plan.length)) -
    Math.min(...plans.map((plan) => plan.length))
  expect(skew(raw.value!)).toBeGreaterThan(bus.maxLengthSkew!)
  const original = run(false)
  expect(skew(original.plans)).toBeLessThanOrEqual(bus.maxLengthSkew!)
  const alternative = run(true)
  // These old selected vias are released in both searches. Their coordinates
  // must not change the common phase around the twelve retained plane vias.
  expect(alternative.plans).toEqual(original.plans)
  expect(alternative.sourcePlans).toEqual(original.sourcePlans)
  const selected = new Set(bus.connections.map((c) => c.connectionIndex))
  const plans = original.sourcePlans.map(
    (source) =>
      original.plans.find(
        (plan) => plan.connectionIndex === source.connectionIndex,
      ) ?? source,
  )
  for (const source of original.sourcePlans) {
    const index = source.connectionIndex
    expect(source.via!.center).toEqual(
      original.fixedViaPointsByConnectionIndex.get(index)!,
    )
    expect(original.sourceEscapePaths.get(index)!.at(-1)).toEqual(
      source.via!.center,
    )
    if (!selected.has(index)) {
      expect(source).toEqual(
        initial.sourcePlans.find((plan) => plan.connectionIndex === index)!,
      )
      expect(original.fixedViaPointsByConnectionIndex.get(index)!).toEqual(
        initial.fixedViaPointsByConnectionIndex.get(index)!,
      )
    }
  }
  for (const plan of original.plans) {
    for (const [index, segment] of plan.segments.entries()) {
      const dx = segment.end.x - segment.start.x
      const dy = segment.end.y - segment.start.y
      expect(
        Math.abs(dx) < 1e-7 ||
          Math.abs(dy) < 1e-7 ||
          Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-7,
      ).toBe(true)
      const previous = plan.segments[index - 1]
      if (previous && previous.layer === segment.layer) {
        const px = previous.end.x - previous.start.x
        const py = previous.end.y - previous.start.y
        expect(
          (dx * px + dy * py) / (Math.hypot(dx, dy) * Math.hypot(px, py)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
      }
      for (const point of [segment.start, segment.end]) {
        expect(point.x).toBeGreaterThanOrEqual(bounds.minX - 1e-7)
        expect(point.x).toBeLessThanOrEqual(bounds.maxX + 1e-7)
        expect(point.y).toBeGreaterThanOrEqual(bounds.minY - 1e-7)
        expect(point.y).toBeLessThanOrEqual(bounds.maxY + 1e-7)
        if (Math.abs(point.x - bounds.maxX) < 1e-7)
          expect(
            Math.hypot(point.x - plan.exitPoint.x, point.y - plan.exitPoint.y),
          ).toBeLessThan(1e-7)
      }
    }
    expect(plan.exitPoint).toEqual(target.exits.get(plan.connectionIndex)!)
    expect(plan.additionalVias ?? []).toHaveLength(0)
    const viaIndex = plan.trace.route.findIndex(
      (point) => point.route_type === "via",
    )
    expect(plan.trace.route[viaIndex]).toMatchObject({
      from_layer: "top",
      to_layer: "inner2",
    })
    for (const point of plan.trace.route.slice(viaIndex + 1))
      if (point.route_type === "wire") expect(point.layer).toBe("inner2")
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
})
