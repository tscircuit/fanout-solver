import { expect, test } from "bun:test"
import "bun-match-svg"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { routeBusWithNativePlaneRecoverySteps } from "../lib/route-bus-with-native-plane-recovery"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

import { fixture } from "./fixtures/native-plane-recovery-fixture"

test("reroutes an ordered blocker and its unfinished suffix while exactly rematching a plane source", async () => {
  const { params, boundary } = fixture()
  const before = JSON.stringify(params)
  const steps = routeBusWithNativePlaneRecoverySteps(params)
  let result = steps.next()
  let usedGroupedRecovery = false
  while (!result.done) {
    if (result.value.connectionCount > 1) usedGroupedRecovery = true
    result = steps.next()
  }
  expect(usedGroupedRecovery).toBe(true)
  expect(result.value).not.toBeNull()
  if (!result.value) throw Error("Expected complete source-aware recovery")
  const recovered = result.value
  expect(recovered.plans).toHaveLength(8)
  expect(
    recovered.plans.filter((plan) => plan.busId === params.bus.busId),
  ).toHaveLength(3)
  expect(JSON.stringify(params)).toBe(before)
  const moved = recovered.sourceEscapes.filter(
    (source, index) =>
      source.via.center.x !== params.sourceEscapes[index]!.via.center.x ||
      source.via.center.y !== params.sourceEscapes[index]!.via.center.y,
  )
  expect(moved.map((source) => source.connectionIndex)).toEqual([3])
  for (const plan of recovered.plans) {
    const original = params.preparedBuses
      .flatMap((bus) => bus.connections)
      .find((c) => c.connectionIndex === plan.connectionIndex)!
    expect(plan.sourcePoint).toEqual(original.sourcePoint)
    expect(plan.targetPoint).toEqual(original.targetPoint)
    expect(plan.sourceObstacle).toBe(original.sourceObstacle)
    expect(plan.via?.spanLayers).toEqual(params.layerNames)
  }
  const output = buildOutputSimpleRouteJson({
    inputSrj: params.srj,
    plans: recovered.plans,
    layerNames: params.layerNames,
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: params.srj,
      routedSrj: output,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, checkedTraceCount: 8, issues: [] })
  expect(
    validateFanoutSolution({
      inputSrj: params.srj,
      outputSrj: output,
      plans: recovered.plans,
      preparedBuses: params.preparedBuses,
      sharedBoundary: boundary,
      clearance: params.clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 8, issues: [] })
  expect(() =>
    routeBusWithNativePlaneRecoverySteps({
      ...params,
      terminals: params.terminals.slice(1),
    }).next(),
  ).toThrow("complete bus")
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...params.srj,
        connections: [],
        traces: recovered.plans.map((plan) => plan.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
})
