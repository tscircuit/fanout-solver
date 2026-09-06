import { expect, test } from "bun:test"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  fanoutPlansAreClear,
  routeBusAlternatives,
  type RouteBusParams,
} from "../lib/route-bus"
import type { Point2D } from "../lib/types"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"
import capturedContext from "./fixtures/singleton-package-edge-context.json"

type CapturedContext = Omit<
  RouteBusParams,
  "fixedViaPointsByConnectionIndex"
> & {
  fixedViaPointsByConnectionIndex: [number, Point2D][]
  componentObstacleIndices: number[]
  sourceObstacleIndices: number[]
  acceptedSourceObstacleIndices: number[]
}

test("a trapped singleton reaches a package-edge via after local escapes fail", async () => {
  // Captured from dataset31 bottom-center after its other 32 boundary traces.
  // Keep all pad geometry and copper; indices restore shared obstacle identity.
  const captured = structuredClone(
    capturedContext,
  ) as unknown as CapturedContext
  const params: RouteBusParams = {
    ...captured,
    fixedViaPointsByConnectionIndex: new Map(
      captured.fixedViaPointsByConnectionIndex,
    ),
  }
  params.bus.componentObstacles = captured.componentObstacleIndices.map(
    (index) => params.srj.obstacles[index]!,
  )
  params.bus.connections.forEach((connection, index) => {
    connection.sourceObstacle =
      params.srj.obstacles[captured.sourceObstacleIndices[index]!]!
  })
  params.acceptedPlans.forEach((plan, index) => {
    plan.sourceObstacle =
      params.srj.obstacles[captured.acceptedSourceObstacleIndices[index]!]!
  })
  params.bus.busId = "CONTROL"
  expect(params.srj.obstacles).toHaveLength(573)
  expect(params.acceptedPlans).toHaveLength(32)

  const plans = routeBusAlternatives(params, 1)[0]!
  expect(plans).toHaveLength(1)
  const plan = plans[0]!
  expect(plan.via!.center.x).toBeLessThan(params.bus.componentBounds.minX)
  expect(plan.sourceEscapeSegmentCount).toBeGreaterThan(1)
  expect(
    plan.trace.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(1)
  const allPlans = [...params.acceptedPlans, ...plans]
  expect(
    fanoutPlansAreClear({
      plans: allPlans,
      srj: params.srj,
      sharedBoundary: params.bus.sharedBoundary,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: params.srj,
      routedSrj: {
        ...params.srj,
        traces: allPlans.map((candidate) => candidate.trace),
      },
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 33,
    checkedViaCount: 33,
    issues: [],
  })

  const background = visualizeSimpleRouteJson({
    ...params.srj,
    obstacles: params.bus.componentObstacles,
    connections: [],
    traces: params.acceptedPlans.map((candidate) => candidate.trace),
  })
  const foreground = visualizeSimpleRouteJson({
    ...params.srj,
    connections: [],
    obstacles: [],
    traces: [plan.trace],
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
      points: [
        { ...plan.sourcePoint, color: "#e8590c", label: "Source" },
        { ...plan.via!.center, color: "#e8590c", label: "Package-edge via" },
        { ...plan.exitPoint, color: "#e8590c", label: "Shared boundary" },
      ],
    }),
  ).toMatchSvgSnapshot(import.meta.path)
}, 30_000)
