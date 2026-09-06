import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { matchComponentDogboneViaSites } from "../lib/match-component-dogbone-via-sites"
import {
  fanoutPlansAreClear,
  routeBusAlternatives,
  type RouteBusParams,
} from "../lib/route-bus"
import type {
  FanoutRoutePlan,
  Point2D,
  PreparedBus,
  PreparedConnection,
} from "../lib/types"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"
import capturedContext from "./fixtures/soft-plane-via-repair-context.json"

type EncodedBus = Omit<PreparedBus, "connections" | "componentObstacles"> & {
  componentObstacles: number
  connections: (Omit<PreparedConnection, "sourceObstacle"> & {
    sourceObstacle: number
  })[]
}
type EncodedPlan = Omit<FanoutRoutePlan, "sourceObstacle"> & {
  sourceObstacle: number
}
type CapturedContext = {
  routeParams: Omit<RouteBusParams, "bus" | "acceptedPlans"> & {
    bus: EncodedBus
    acceptedPlans: EncodedPlan[]
  }
  componentObstacleGroups: number[][]
  preparedBuses: EncodedBus[]
  preferredBoundaryPerpendicularSideByBusId: [string, -1 | 1][]
  preferBoundaryOutwardByBusId: [string, boolean][]
  originalViaPoints: [number, Point2D][]
  preferPlaneCheckerboardSites: boolean
}

test("soft plane reservations preserve a complete via assignment during wide-bus repair", async () => {
  const captured = structuredClone(
    capturedContext,
  ) as unknown as CapturedContext
  const { srj } = captured.routeParams
  const hydrateBus = (bus: EncodedBus): PreparedBus => ({
    ...bus,
    componentObstacles: captured.componentObstacleGroups[
      bus.componentObstacles
    ]!.map((index) => srj.obstacles[index]!),
    connections: bus.connections.map((connection) => ({
      ...connection,
      sourceObstacle: srj.obstacles[connection.sourceObstacle]!,
    })),
  })
  const preparedBuses = captured.preparedBuses.map(hydrateBus)
  const params: RouteBusParams = {
    ...captured.routeParams,
    bus: hydrateBus(captured.routeParams.bus),
    acceptedPlans: captured.routeParams.acceptedPlans.map((plan) => ({
      ...plan,
      sourceObstacle: srj.obstacles[plan.sourceObstacle]!,
    })),
  }
  expect(params.bus.connections).toHaveLength(8)
  expect(params.acceptedPlans).toHaveLength(9)
  expect(params.softReservedVias).toHaveLength(102)
  expect(params.allowSameNetMerges).toBe(false)
  // Hard plane reservations prevent any local dogbone repair in this field.
  expect(
    routeBusAlternatives(
      {
        ...params,
        softReservedVias: [],
        reservedVias: [...params.reservedVias!, ...params.softReservedVias!],
      },
      1,
    ),
  ).toEqual([])
  const plans = routeBusAlternatives(params, 1)[0]!
  expect(plans).toHaveLength(8)
  const allPlans = [...params.acceptedPlans, ...plans]
  const rematched = matchComponentDogboneViaSites(preparedBuses, {
    viaDiameter: params.viaDiameter,
    viaHoleDiameter: params.viaHoleDiameter,
    traceWidth: params.traceWidth,
    clearance: params.clearance,
    maximumSearchStates: 3_000_000,
    preferredBoundaryPerpendicularSideByBusId: new Map(
      captured.preferredBoundaryPerpendicularSideByBusId,
    ),
    preferBoundaryOutwardByBusId: new Map(
      captured.preferBoundaryOutwardByBusId,
    ),
    fixedViaPointsByConnectionIndex: new Map(
      allPlans
        .filter((plan) => plan.via)
        .map((plan) => [plan.connectionIndex, plan.via!.center]),
    ),
    preferredViaPointsByConnectionIndex: new Map(captured.originalViaPoints),
    blockingSegments: allPlans.flatMap((plan) =>
      plan.segments.map((segment) => ({
        connectionIndex: plan.connectionIndex,
        segment,
      })),
    ),
    additionalObstacles: srj.obstacles,
    preferPlaneCheckerboardSites: captured.preferPlaneCheckerboardSites,
  })
  expect(rematched?.size).toBe(135)
  for (const plan of allPlans)
    expect(rematched!.get(plan.connectionIndex)).toEqual(plan.via!.center)
  expect(
    fanoutPlansAreClear({
      plans: allPlans,
      srj,
      sharedBoundary: params.bus.sharedBoundary,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: { ...srj, traces: allPlans.map((plan) => plan.trace) },
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 17,
    checkedViaCount: 17,
    issues: [],
  })
  const background = visualizeSimpleRouteJson({
    ...srj,
    obstacles: params.bus.componentObstacles,
    connections: [],
    traces: params.acceptedPlans.map((plan) => plan.trace),
  })
  const foreground = visualizeSimpleRouteJson({
    ...srj,
    obstacles: [],
    connections: [],
    traces: plans.map((plan) => plan.trace),
  })
  await expect(
    getSvgFromGraphicsObject({
      ...background,
      lines: [
        ...(background.lines ?? []).map((line) => ({
          ...line,
          strokeColor: "#aab3bd",
        })),
        ...(foreground.lines ?? []).map((line) => ({
          ...line,
          strokeColor: "#e8590c",
        })),
      ],
      circles: [
        ...(background.circles ?? []).map((circle) => ({
          ...circle,
          fill: "#aab3bd",
        })),
        ...(foreground.circles ?? []).map((circle) => ({
          ...circle,
          fill: "#e8590c",
        })),
      ],
    }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 120_000)
