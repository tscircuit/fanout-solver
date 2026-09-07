import { expect, test } from "bun:test"
import "bun-match-svg"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { routeDeclaredLayerBridgeSteps } from "../lib/route-declared-layer-bridge"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"
import { makeDeclaredLayerBridgeFixture } from "./fixtures/declared-layer-bridge-fixture"

test("both bounded queue policies preserve two declared primary landings and immutable sources", async () => {
  for (const blockedOrderPolicy of [
    "prioritize-blocked",
    "append-blocked",
  ] as const) {
    const f = makeDeclaredLayerBridgeFixture(true)
    const params = {
      ...f.params,
      sourcePlans: f.sourcePlans,
      blockedOrderPolicy,
    }
    const before = JSON.stringify(params)
    const steps = routeDeclaredLayerBridgeSteps(params)
    let step = steps.next()
    while (!step.done) step = steps.next()
    expect(step.value?.plans).toHaveLength(2)
    if (!step.value) throw new Error("Expected both bridge lanes")
    expect(JSON.stringify(params)).toBe(before)
    expect(step.value.requiresLengthMatching).toBe(false)
    expect(step.value.searchCount).toBeLessThan(256)
    for (const plan of step.value.plans) {
      const connection = f.bus.connections.find(
        (c) => c.connectionIndex === plan.connectionIndex,
      )!
      const source = f.sourceEscapes.find(
        (s) => s.connectionIndex === plan.connectionIndex,
      )!
      expect(plan.sourceObstacle).toBe(connection.sourceObstacle)
      expect(plan.sourcePoint).toEqual(connection.sourcePoint)
      expect(plan.targetPoint).toEqual(connection.targetPoint)
      expect(plan.segments.slice(0, plan.sourceEscapeSegmentCount)).toEqual(
        source.segments,
      )
      expect(plan.via?.center).toEqual(source.via.center)
      expect(plan.via?.spanLayers).toEqual(f.layerNames)
      expect(plan.via?.toLayer).toBe("inner1")
      expect(plan.additionalVias).toHaveLength(1)
      expect(plan.targetLayer).toBe("bottom")
      expect(plan.cornerBandSide).toBe("maximum")
      expect(plan.exitPoint.x).toBe(f.boundary.minX)
      expect(plan.exitPoint.y).toBeGreaterThan(0)
    }
    const plans = [f.wall, ...step.value.plans]
    const output = buildOutputSimpleRouteJson({
      inputSrj: f.srj,
      plans,
      layerNames: f.layerNames,
    })
    expect(
      validateFanoutSolution({
        inputSrj: f.srj,
        outputSrj: output,
        plans,
        preparedBuses: [f.bus, f.wallBus],
        sharedBoundary: f.boundary,
        clearance: f.clearance,
        allowBlindAndBuriedVias: false,
      }),
    ).toMatchObject({ valid: true, brokenOutConnectionCount: 3, issues: [] })
    expect(
      validateRoutedCopperDrc({
        inputSrj: f.srj,
        routedSrj: output,
        clearance: f.clearance,
        allowBlindAndBuriedVias: false,
      }),
    ).toMatchObject({ valid: true, issues: [] })
    await expect(
      getSvgFromGraphicsObject(
        visualizeSimpleRouteJson({ ...output, connections: [] }),
      ),
    ).toMatchSvgSnapshot(import.meta.path, blockedOrderPolicy)
  }
})
