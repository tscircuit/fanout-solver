import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { FanoutSolver } from "lib/fanout-solver"
import { distance, distancePointToSegment } from "lib/geometry"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { matchComponentDogboneViaSiteAlternatives } from "lib/match-component-dogbone-via-sites"
import { fanoutPlansAreClear, routeBusAlternatives } from "lib/route-bus"
import type { FanoutRoutePlan, FanoutSolverOptions, Point2D } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import capturedFixture from "./fixtures/am62l-north-orbit-byte0-fanout-repro.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

const EPSILON = 1e-9

function getBusSkew(plans: readonly FanoutRoutePlan[]): number {
  const lengths = plans.map((plan) => plan.length)
  return Math.max(...lengths) - Math.min(...lengths)
}

function isOctilinear(start: Point2D, end: Point2D): boolean {
  const dx = Math.abs(end.x - start.x)
  const dy = Math.abs(end.y - start.y)
  return dx < EPSILON || dy < EPSILON || Math.abs(dx - dy) < EPSILON
}

test("rematches BYTE0 dogbone sites when the baseline route cannot meet its skew", () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  const byte0Bus = solver.preparedBuses.find((bus) => bus.busId === "DDR_BYTE0")
  expect(byte0Bus).toBeDefined()
  if (!byte0Bus) throw new Error("DDR_BYTE0 was not prepared")

  const targetLayer = solver.layerAssignments[0]?.[byte0Bus.busId]
  expect(targetLayer).toBe("inner1")
  if (!targetLayer) throw new Error("DDR_BYTE0 has no target layer")

  const { traceWidth, viaDiameter, viaHoleDiameter, clearance, layerNames } =
    solver.config
  const maximumSkew = byte0Bus.maxLengthSkew
  expect(maximumSkew).toBe(8)
  if (maximumSkew === undefined) {
    throw new Error("DDR_BYTE0 has no maximum length skew")
  }

  const baselineViaPoints = new Map<number, Point2D>([
    [0, { x: -4.25, y: 3.25 }],
    [1, { x: -4.25, y: 2.75 }],
    [2, { x: -4.25, y: 2.25 }],
    [3, { x: -5.25, y: 2.25 }],
    [4, { x: -3.75, y: 3.25 }],
    [5, { x: -5.75, y: 3.75 }],
    [6, { x: -5.75, y: 3.25 }],
    [7, { x: -4.75, y: 2.25 }],
  ])
  const unchangedConnectionIndices = new Set([0, 3, 5, 6])
  const unchangedViaPoints = new Map(
    [...baselineViaPoints].filter(([connectionIndex]) =>
      unchangedConnectionIndices.has(connectionIndex),
    ),
  )
  const resetReservation = {
    connectionName: "DDR_RESET_RESERVATION",
    via: {
      center: { x: -5.25, y: 1.75 },
      diameter: viaDiameter,
      spanLayers: layerNames,
    },
  }

  const routeWithViaPoints = (
    fixedViaPointsByConnectionIndex: ReadonlyMap<number, Point2D>,
  ): FanoutRoutePlan[] | null =>
    routeBusAlternatives(
      {
        srj: fixture.inputSrj,
        bus: byte0Bus,
        targetLayer,
        acceptedPlans: [],
        layerNames,
        traceWidth,
        viaDiameter,
        viaHoleDiameter,
        clearance,
        compactBusTracks: true,
        allowBlindAndBuriedVias: false,
        allowSameNetMerges: false,
        fixedViaPointsByConnectionIndex,
        reservedVias: [resetReservation],
        viaMinimalOnly: true,
        fixedViaWindingOnly: true,
        expandedStateBudget: { remaining: 2_000_000 },
      },
      1,
    )[0] ?? null

  const baselinePlans = routeWithViaPoints(baselineViaPoints)
  expect(baselinePlans).not.toBeNull()
  if (!baselinePlans) throw new Error("baseline BYTE0 sites did not route")
  expect(getBusSkew(baselinePlans)).toBeGreaterThan(maximumSkew)

  const baselineLengthMatch = matchBusPlanLengths({
    plans: baselinePlans,
    preparedBuses: [byte0Bus],
    inputSrj: fixture.inputSrj,
    sharedBoundary: byte0Bus.sharedBoundary,
    clearance,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    allowMatchingInsideDenseBounds: true,
  })
  expect(baselineLengthMatch.plans).toBeNull()
  if (baselineLengthMatch.plans === null) {
    expect(baselineLengthMatch.failedBus.busId).toBe(byte0Bus.busId)
  }

  const rematchedViaPointMaps = matchComponentDogboneViaSiteAlternatives(
    [byte0Bus],
    {
      viaDiameter,
      viaHoleDiameter,
      traceWidth,
      clearance,
      maximumSearchStates: 100_000,
      fixedViaPointsByConnectionIndex: unchangedViaPoints,
    },
    3,
  )
  expect(rematchedViaPointMaps).toHaveLength(3)
  for (const viaPoints of rematchedViaPointMaps) {
    for (const [connectionIndex, point] of unchangedViaPoints) {
      expect(viaPoints.get(connectionIndex)).toEqual(point)
    }
  }

  const rematchedRoutes = rematchedViaPointMaps.map((viaPoints) => {
    const plans = routeWithViaPoints(viaPoints)
    expect(plans).not.toBeNull()
    return {
      viaPoints,
      plans,
      skew: plans ? getBusSkew(plans) : Number.POSITIVE_INFINITY,
    }
  })
  const selected = rematchedRoutes.find(
    ({ plans, skew }) => plans !== null && skew <= maximumSkew + EPSILON,
  )
  expect(selected).toBeDefined()
  if (!selected?.plans) {
    throw new Error(
      "three bounded dogbone alternatives did not meet BYTE0 skew",
    )
  }

  expect(selected.skew).toBeLessThanOrEqual(maximumSkew + EPSILON)
  expect(
    [...selected.viaPoints].some(([connectionIndex, point]) => {
      const baselinePoint = baselineViaPoints.get(connectionIndex)
      return (
        baselinePoint !== undefined && distance(point, baselinePoint) > EPSILON
      )
    }),
  ).toBe(true)
  for (const [connectionIndex, point] of selected.viaPoints) {
    expect(
      selected.plans.find((plan) => plan.connectionIndex === connectionIndex)
        ?.via?.center,
    ).toEqual(point)
  }

  expect(selected.plans).toHaveLength(8)
  expect(
    selected.plans.every((plan) => (plan.additionalVias ?? []).length === 0),
  ).toBe(true)
  expect(
    selected.plans
      .flatMap((plan) => plan.segments)
      .every((segment) => isOctilinear(segment.start, segment.end)),
  ).toBe(true)
  expect(
    fanoutPlansAreClear({
      plans: selected.plans,
      srj: fixture.inputSrj,
      sharedBoundary: byte0Bus.sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
      allowSameNetMerges: false,
    }),
  ).toBe(true)

  for (const plan of selected.plans) {
    expect(plan.via).toBeDefined()
    if (!plan.via) continue
    expect(
      distance(resetReservation.via.center, plan.via.center) + EPSILON,
    ).toBeGreaterThanOrEqual(
      resetReservation.via.diameter / 2 + plan.via.diameter / 2 + clearance,
    )
    for (const segment of plan.segments) {
      expect(
        distancePointToSegment(
          resetReservation.via.center,
          segment.start,
          segment.end,
        ) + EPSILON,
      ).toBeGreaterThanOrEqual(
        resetReservation.via.diameter / 2 + segment.width / 2 + clearance,
      )
    }
  }

  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: fixture.inputSrj,
    plans: selected.plans,
    layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: fixture.inputSrj,
      routedSrj: outputSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 8,
    checkedViaCount: 8,
    issues: [],
  })
}, 20_000)
