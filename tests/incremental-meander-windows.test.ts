import { expect, test } from "bun:test"
import "bun-match-svg"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { matchBusPlanLengthsIncrementally } from "../lib/match-bus-lengths"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

import { createNarrowMeanderFixture } from "./fixtures/narrow-meander-fixture"

test("matches a bus across separate narrow tuning windows", async () => {
  const {
    srj,
    bus,
    plans,
    params,
    boundary,
    layerNames,
    clearance,
    snapshot,
    fragmented,
  } = createNarrowMeanderFixture()
  const incremental = matchBusPlanLengthsIncrementally({
    ...params,
    inputSrj: fragmented,
  })
  expect(incremental.plans).not.toBeNull()
  if (!incremental.plans) throw Error("Expected separate tuning windows")
  expect(incremental.plans[1]).toBe(plans[1])
  expect(incremental.plans[0]!.sourcePoint).toBe(plans[0]!.sourcePoint)
  expect(incremental.plans[0]!.via).toEqual(plans[0]!.via)
  expect(incremental.plans[0]!.segments[0]).toEqual(plans[0]!.segments[0])
  expect(JSON.stringify({ srj, bus, plans })).toBe(snapshot)
  const incrementalOutput = buildOutputSimpleRouteJson({
    inputSrj: fragmented,
    plans: incremental.plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: fragmented,
      outputSrj: incrementalOutput,
      plans: incremental.plans,
      preparedBuses: [bus],
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: fragmented,
      routedSrj: incrementalOutput,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...fragmented,
        connections: [],
        traces: incremental.plans.map((p) => p.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 30_000)
