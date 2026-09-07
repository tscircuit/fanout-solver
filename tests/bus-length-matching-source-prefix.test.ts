import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { distancePointToSegment, distanceSegmentToObstacle } from "lib/geometry"
import {
  matchBusPlanLengths,
  replacementCopperIsSelfClear,
} from "lib/match-bus-lengths"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("optionally tunes a source prefix while preserving the first pad leg, first via, and narrow target corridor", async () => {
  const traceWidth = 0.08128,
    clearance = 0.08128,
    layerNames = ["top", "bottom"]
  const sharedBoundary = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const pads: Obstacle[] = [-1, 1].map((y, i) => ({
    type: "rect",
    shape: "circle",
    center: { x: -2.5, y },
    width: 0.12,
    height: 0.12,
    componentId: "U1",
    layers: ["top"],
    connectedTo: [`signal${i}`],
  }))
  const connections: PreparedConnection[] = pads.map((sourceObstacle, i) => {
    const sourcePoint = {
        ...sourceObstacle.center,
        layer: "top",
        pointId: `pad${i}`,
      },
      targetPoint = { x: 4, y: sourcePoint.y, layer: "bottom" }
    return {
      connection: {
        name: `signal${i}`,
        pointsToConnect: [sourcePoint, targetPoint],
      },
      connectionIndex: i,
      sourcePointIndex: 0,
      sourcePoint,
      sourceObstacle,
      sourceLayer: "top",
      targetPoint,
    }
  })
  const bus: PreparedBus = {
    busId: "PAIR",
    componentId: "U1",
    direction: "right",
    preferredExit: "right",
    exitEdge: "right",
    termination: { type: "boundary" },
    maxLengthSkew: 0.05,
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    componentObstacles: pads,
    componentBounds: { minX: -2.56, maxX: -2.44, minY: -1.06, maxY: 1.06 },
    xCoordinates: [-2.5],
    yCoordinates: [-1, 1],
    pitchX: 0.65,
    pitchY: 2,
    sharedBoundary,
    connections,
  }
  const inputSrj: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: traceWidth,
    bounds: { ...sharedBoundary, maxX: 5 },
    connections: connections.map((c) => c.connection),
    obstacles: [
      ...pads,
      ...[-1, 1].map((sign) => ({
        type: "rect" as const,
        center: { x: 2.375, y: -1 + sign * 0.30192 },
        width: 1.25,
        height: 0.36,
        layers: ["bottom"],
        connectedTo: [`wall:${sign}`],
      })),
    ],
  }
  const rules = {
    traceWidth,
    clearance,
    layerNames,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    allowBlindAndBuriedVias: false,
  }
  const plans = connections.map((connection, i) => {
    const viaPoint = { x: 1.5, y: connection.sourcePoint.y },
      exitPoint = { x: 3, y: viaPoint.y }
    return buildViaMinimalWindingPlan({
      ...rules,
      bus,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: "bottom",
      targetLayerPoints: [viaPoint, exitPoint],
      sourceEscapePoints:
        i === 0
          ? [connection.sourcePoint, { x: -2.48, y: -1 }, viaPoint]
          : [
              connection.sourcePoint,
              { x: -2, y: 1 },
              { x: -1.5, y: 1.5 },
              { x: 0.5, y: 1.5 },
              { x: 1, y: 1 },
              viaPoint,
            ],
    })
  })
  const original = structuredClone(plans),
    params = {
      ...rules,
      plans,
      preparedBuses: [bus],
      inputSrj,
      sharedBoundary,
      maximumWorkUnits: 1000,
    }
  expect(matchBusPlanLengths(params).plans).toBeNull()
  expect(plans).toEqual(original)
  const result = matchBusPlanLengths({
    ...params,
    allowSourcePrefixMatching: true,
  })
  expect(result.plans).toHaveLength(2)
  if (!result.plans)
    throw new Error("Expected source-prefix tuning to match the complete pair")
  expect(plans).toEqual(original)
  expect(result.plans[1]).toEqual(plans[1])
  const tuned = result.plans[0]!,
    count = tuned.sourceEscapeSegmentCount!
  expect(count).toBeGreaterThan(plans[0]!.sourceEscapeSegmentCount!)
  expect(tuned.segments[0]).toEqual(plans[0]!.segments[0])
  expect(tuned.via).toEqual(plans[0]!.via)
  expect(tuned.exitPoint).toEqual(plans[0]!.exitPoint)
  expect(tuned.sourceObstacle).toBe(plans[0]!.sourceObstacle)
  expect(tuned.segments.slice(count)).toEqual(
    plans[0]!.segments.slice(plans[0]!.sourceEscapeSegmentCount),
  )
  expect(tuned.segments[count - 1]!.end).toEqual(tuned.via!.center)
  expect(tuned.segments[count]!.layer).toBe("bottom")
  expect(tuned.trace.route.filter((p) => p.route_type === "via")).toEqual(
    plans[0]!.trace.route.filter((p) => p.route_type === "via"),
  )
  // The immutable first leg ends inside its pad. The following TOP run must
  // split at the dense envelope before its outside portion becomes tunable.
  expect(tuned.segments[1]!.end.x).toBeCloseTo(
    -2.44 + traceWidth / 2 + clearance,
    7,
  )
  const oldSpan = plans[0]!.segments[1]!
  for (const s of tuned.segments.slice(1, count)) {
    if (
      [s.start, s.end].every(
        (p) => distancePointToSegment(p, oldSpan.start, oldSpan.end) < 1e-7,
      )
    )
      continue
    expect(
      distanceSegmentToObstacle(s, tuned.sourceObstacle),
    ).toBeGreaterThanOrEqual(traceWidth / 2 + clearance - 1e-6)
  }
  expect(
    replacementCopperIsSelfClear({
      plan: plans[0]!,
      segments: tuned.segments,
      replacementStartIndex: 1,
      replacementSegmentCount: count - 1,
      clearance,
    }),
  ).toBe(true)
  for (const p of result.plans)
    for (let i = 0; i < p.segments.length; i++) {
      const s = p.segments[i]!,
        dx = s.end.x - s.start.x,
        dy = s.end.y - s.start.y
      expect(
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ),
      ).toBeLessThan(1e-7)
      const prev = p.segments[i - 1]
      if (prev && prev.layer === s.layer) {
        const ax = prev.end.x - prev.start.x,
          ay = prev.end.y - prev.start.y
        expect(
          (ax * dx + ay * dy) / (Math.hypot(ax, ay) * Math.hypot(dx, dy)),
        ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
      }
    }
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj,
    plans: result.plans,
    layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: outputSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj,
      plans: result.plans,
      preparedBuses: [bus],
      sharedBoundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...outputSrj, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
