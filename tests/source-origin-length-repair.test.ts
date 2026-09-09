import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "lib/build-output"
import { matchBusPlanLengths } from "lib/match-bus-lengths"
import { normalizeFanoutPlanCorners } from "lib/normalize-fanout-plan-corners"
import { rerouteSourceOriginLengthsSteps } from "lib/reroute-source-origin-lengths"
import { buildViaMinimalWindingPlan } from "lib/route-via-minimal-winding"
import type { PreparedBus, PreparedConnection } from "lib/types"
import { validateFanoutSolution } from "lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "lib/visualize-simple-route-json"

test("jointly shortens a mismatched pair without changing another source reservation", async () => {
  const bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3 }
  const rules = {
    traceWidth: 0.08128,
    clearance: 0.08128,
    viaDiameter: 0.24,
    viaHoleDiameter: 0.1,
    layerNames: ["top", "inner1", "bottom"],
  }
  const pads: Obstacle[] = [0.5, -0.5, -2].map((y, i) => ({
    type: "rect",
    shape: "circle",
    componentId: "U1",
    center: { x: -2.5, y },
    width: 0.3,
    height: 0.3,
    layers: ["top"],
    connectedTo: [`N${i}`],
  }))
  const connections: PreparedConnection[] = pads.map((sourceObstacle, i) => {
    const sourcePoint = {
      ...sourceObstacle.center,
      layer: "top",
      pointId: `P${i}`,
    }
    const targetPoint = {
      x: 4,
      y: sourcePoint.y,
      layer: i < 2 ? "bottom" : "inner1",
    }
    return {
      connection: {
        name: `N${i}`,
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
  const pair: PreparedBus = {
    busId: "PAIR",
    componentId: "U1",
    direction: "right",
    exitEdge: "right",
    preferredExit: "right",
    termination: { type: "boundary" },
    allowedLayers: ["bottom"],
    routableEscapeLayers: ["bottom"],
    maxLengthSkew: 0.1,
    componentObstacles: pads,
    componentBounds: { minX: -2.65, maxX: -2.35, minY: -2.15, maxY: 0.65 },
    xCoordinates: [-2.5],
    yCoordinates: [-2, -0.5, 0.5],
    pitchX: 0.65,
    pitchY: 1,
    sharedBoundary: bounds,
    connections: connections.slice(0, 2),
  }
  const plane: PreparedBus = {
    ...pair,
    busId: "PLANE",
    exitEdge: undefined,
    preferredExit: undefined,
    connections: [connections[2]!],
    termination: { type: "plane", layer: "inner1" },
    allowedLayers: ["inner1"],
    routableEscapeLayers: ["inner1"],
    maxLengthSkew: undefined,
  }
  const buses = [pair, plane]
  const inputSrj: SimpleRouteJson = {
    bounds: { ...bounds, maxX: 4 },
    layerCount: 3,
    minTraceWidth: rules.traceWidth,
    obstacles: pads,
    connections: connections.map((c) => c.connection),
  }
  const plans = connections.map((connection, i) => {
    const viaPoint = { x: -2, y: connection.sourcePoint.y }
    const exitPoint = i < 2 ? { x: 3, y: viaPoint.y } : viaPoint
    return buildViaMinimalWindingPlan({
      ...rules,
      bus: i < 2 ? pair : plane,
      terminal: { connection, viaPoint, exitPoint },
      targetLayer: i < 2 ? "bottom" : "inner1",
      sourceEscapePoints: [connection.sourcePoint, viaPoint],
      targetLayerPoints:
        i === 0
          ? [
              viaPoint,
              { x: -1.8, y: 0.5 },
              { x: -1.6, y: 0.7 },
              { x: -1.6, y: 1.6 },
              { x: -1.4, y: 1.8 },
              { x: 1.4, y: 1.8 },
              { x: 1.6, y: 1.6 },
              { x: 1.6, y: 0.7 },
              { x: 1.8, y: 0.5 },
              exitPoint,
            ]
          : i === 1
            ? [viaPoint, exitPoint]
            : [viaPoint],
      allowBlindAndBuriedVias: false,
    })
  })
  const original = structuredClone(plans)
  expect(plans[0]!.length - plans[1]!.length).toBeGreaterThan(2)
  const steps = rerouteSourceOriginLengthsSteps({
    ...rules,
    inputSrj,
    plans,
    preparedBuses: buses,
    bus: pair,
  })
  let next = steps.next()
  while (!next.done) next = steps.next()
  expect(next.value).not.toBeNull()
  expect(plans).toEqual(original)
  const repaired = next.value!
  expect(repaired).toHaveLength(3)
  expect(repaired[2]).toBe(plans[2])
  expect(repaired[0]!.via!.center).not.toEqual(plans[0]!.via!.center)
  expect(Math.abs(repaired[0]!.length - repaired[1]!.length)).toBeLessThan(
    plans[0]!.length - plans[1]!.length,
  )
  for (const plan of repaired) {
    const old = plans.find((p) => p.connectionIndex === plan.connectionIndex)!
    expect(plan.sourcePoint).toEqual(old.sourcePoint)
    expect(plan.exitPoint).toEqual(old.exitPoint)
    expect(plan.targetLayer).toBe(old.targetLayer)
    expect(plan.sourceObstacle).toBe(old.sourceObstacle)
    expect(plan.via!.spanLayers).toEqual(rules.layerNames)
    expect(
      plan.segments[(plan.sourceEscapeSegmentCount ?? 1) - 1]!.end,
    ).toEqual(plan.via!.center)
  }
  const matched = matchBusPlanLengths({
    ...rules,
    inputSrj,
    plans: repaired,
    preparedBuses: buses,
    sharedBoundary: bounds,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    allowSourcePrefixMatching: true,
    allowMatchingInsideDenseBounds: true,
    maximumWorkUnits: 1000,
  })
  expect(matched.plans).not.toBeNull()
  const normalized = normalizeFanoutPlanCorners({
    ...rules,
    inputSrj,
    plans: matched.plans!,
    preparedBuses: buses,
  })
  expect(normalized).not.toBeNull()
  const output = buildOutputSimpleRouteJson({
    inputSrj,
    plans: normalized!,
    layerNames: rules.layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj,
      outputSrj: output,
      plans: normalized!,
      preparedBuses: buses,
      sharedBoundary: bounds,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).issues,
  ).toEqual([])
  expect(
    validateRoutedCopperDrc({
      inputSrj,
      routedSrj: output,
      clearance: rules.clearance,
      allowBlindAndBuriedVias: false,
    }).issues,
  ).toEqual([])
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({ ...output, connections: [] }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
