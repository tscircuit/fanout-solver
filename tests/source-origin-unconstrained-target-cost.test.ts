import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { distance } from "lib/geometry"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { getLayerReservedBusTargets } from "lib/route-layer-reserved-buses"
import { routeReservedViaBusesSteps } from "lib/route-reserved-via-buses"
import {
  prepareSourceOriginReservations,
  routeSourceOriginBusesSteps,
} from "lib/route-source-origin-buses"
import type { FanoutBusSpec, FanoutRoutePlan } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { expectStraightOr45Fanout } from "./fixtures/expect-straight-or-45-fanout"

const sourcePrefixLength = (plan: FanoutRoutePlan): number =>
  plan.segments
    .slice(0, plan.sourceEscapeSegmentCount ?? 1)
    .reduce((sum, segment) => sum + distance(segment.start, segment.end), 0)

test("source-origin target-layer cost shifts unconstrained buses onto top so constrained lanes fit a shared aperture", () => {
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
  const buses: FanoutBusSpec[] = []
  const addressSignals: string[] = []
  let resetSignal = ""

  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      const index = row * 4 + column
      const name = `N${index}`
      const port = `P${index}`
      const source = { x: -1.6 + (column - 1.5) * 0.65, y: (row - 1.5) * 0.65 }
      const isAddress = column === 3
      const isReset = column === 2 && row === 2
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
          ...(isAddress || isReset
            ? [{ x: 4, y: isReset ? 0.7 : source.y * 0.5, layer: "inner2" }]
            : []),
        ],
      })
      if (isAddress) addressSignals.push(name)
      else if (isReset) resetSignal = name
      else
        buses.push({
          busId: name,
          connectionNames: [name],
          sourceComponentId: "U1",
          direction: "right",
          termination: { type: "plane", layer: "inner1" },
        })
    }
  }

  // The 1.22mm inner2 aperture admits four grid lanes, not five. Without a
  // target-layer cost on unconstrained buses, reset claims one of the four
  // inner2 tracks first and pushes an address lane onto the top detour.
  srj.obstacles.push(
    {
      type: "rect",
      center: { x: 0.5, y: 2.305 },
      width: 0.2,
      height: 3.39,
      layers: ["inner2"],
      connectedTo: ["inner2_wall_top"],
    },
    {
      type: "rect",
      center: { x: 0.5, y: -2.305 },
      width: 0.2,
      height: 3.39,
      layers: ["inner2"],
      connectedTo: ["inner2_wall_bottom"],
    },
    {
      type: "rect",
      center: { x: 0.5, y: 0 },
      width: 0.2,
      height: 5.8,
      layers: ["top"],
      connectedTo: ["top_detour_wall"],
    },
  )

  buses.push(
    {
      busId: "reset",
      connectionNames: [resetSignal],
      sourceComponentId: "U1",
      direction: "right",
      preferredExit: "right",
      exitEdge: "right",
      allowedLayers: ["inner2"],
    },
    {
      busId: "address",
      connectionNames: addressSignals,
      sourceComponentId: "U1",
      direction: "right",
      preferredExit: "right",
      exitEdge: "right",
      allowedLayers: ["inner2"],
      maxLengthSkew: 1.5,
    },
  )

  const prepared = prepareFanoutBuses(srj, {
    buses,
    sharedBoundary: bounds,
    escapeLayers: ["inner2"],
  })
  const params = { ...rules, srj, buses: prepared, layerNames }
  const initial = prepareSourceOriginReservations(params)!
  expect(initial).not.toBeNull()
  const targets = getLayerReservedBusTargets(params)!
  const signalBuses = prepared.filter((b) => b.termination.type === "boundary")
  const before = JSON.stringify({
    srj,
    prepared,
    sites: [...initial.fixedViaPointsByConnectionIndex],
    paths: [...initial.sourceEscapePaths],
    sourcePlans: initial.sourcePlans,
  })

  const baseRouteParams = {
    ...params,
    allBuses: prepared,
    buses: signalBuses,
    targetLayer: "inner2",
    fixedViaPointsByConnectionIndex: new Map(
      initial.fixedViaPointsByConnectionIndex,
    ),
    sourceEscapePaths: new Map(initial.sourceEscapePaths),
    acceptedPlans: [],
    terminals: signalBuses.flatMap((bus) =>
      bus.connections.map((connection) => ({
        connection,
        viaPoint: initial.fixedViaPointsByConnectionIndex.get(
          connection.connectionIndex,
        )!,
        exitPoint: targets.exits.get(connection.connectionIndex)!,
      })),
    ),
    tightViaChannels: true,
    ripCost: 64,
  }

  for (const invalidCost of [0, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const steps = routeReservedViaBusesSteps({
      ...baseRouteParams,
      routeFromSourcePads: true,
      unconstrainedTargetLayerCost: invalidCost,
    })
    expect(() => steps.next()).toThrow(
      "unconstrainedTargetLayerCost must be finite and at least one",
    )
  }

  const defaultSteps = routeSourceOriginBusesSteps({
    ...baseRouteParams,
    fixedViaPointsByConnectionIndex: new Map(
      initial.fixedViaPointsByConnectionIndex,
    ),
    sourceEscapePaths: new Map(initial.sourceEscapePaths),
  })
  let defaultStep = defaultSteps.next()
  while (!defaultStep.done) defaultStep = defaultSteps.next()
  expect(defaultStep.value).not.toBeNull()
  const defaultAddress = defaultStep.value!.plans.filter(
    (plan) => plan.busId === "address",
  )
  const defaultReset = defaultStep.value!.plans.find(
    (plan) => plan.busId === "reset",
  )!
  const defaultSkew =
    Math.max(...defaultAddress.map((plan) => plan.length)) -
    Math.min(...defaultAddress.map((plan) => plan.length))
  expect(defaultSkew).toBeGreaterThan(1.2)

  const biasedSteps = routeSourceOriginBusesSteps({
    ...baseRouteParams,
    fixedViaPointsByConnectionIndex: new Map(
      initial.fixedViaPointsByConnectionIndex,
    ),
    sourceEscapePaths: new Map(initial.sourceEscapePaths),
    unconstrainedTargetLayerCost: 4,
  })
  let biasedStep = biasedSteps.next()
  while (!biasedStep.done) biasedStep = biasedSteps.next()
  expect(biasedStep.value).not.toBeNull()

  const biasedAddress = biasedStep.value!.plans.filter(
    (plan) => plan.busId === "address",
  )
  const biasedReset = biasedStep.value!.plans.find(
    (plan) => plan.busId === "reset",
  )!
  const biasedSkew =
    Math.max(...biasedAddress.map((plan) => plan.length)) -
    Math.min(...biasedAddress.map((plan) => plan.length))

  expect(sourcePrefixLength(biasedReset)).toBeGreaterThan(
    sourcePrefixLength(defaultReset) + 2,
  )
  expect(biasedReset.via!.center.x).toBeGreaterThan(0.6)
  expect(biasedSkew).toBeLessThan(0.8)
  for (const plan of biasedAddress) {
    expect(plan.via!.center.x).toBeLessThan(0.4)
  }

  const routedIndices = new Set(
    biasedStep.value!.plans.map((plan) => plan.connectionIndex),
  )
  const fullPlans = [
    ...biasedStep.value!.plans,
    ...biasedStep.value!.sourcePlans.filter(
      (plan) => !routedIndices.has(plan.connectionIndex),
    ),
  ]
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: fullPlans,
    layerNames,
  })
  expectStraightOr45Fanout(fullPlans.map((plan) => plan.trace))
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans: fullPlans,
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
  expect(
    JSON.stringify({
      srj,
      prepared,
      sites: [...initial.fixedViaPointsByConnectionIndex],
      paths: [...initial.sourceEscapePaths],
      sourcePlans: initial.sourcePlans,
    }),
  ).toBe(before)
})
