import { expect, test } from "bun:test"
import "bun-match-svg"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { matchBusPlanLengthsIncrementally } from "../lib/match-bus-lengths"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"

import { createNarrowMeanderFixture } from "./fixtures/narrow-meander-fixture"

test("preserves a caller-protected corridor while adding incremental bus length", () => {
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
  const protectedRight = matchBusPlanLengthsIncrementally({
    ...params,
    inputSrj: fragmented,
    candidatePlansAreFeasible: (candidatePlans) =>
      candidatePlans[0]!.segments
        .slice(1)
        .every((segment) => segment.start.x <= 1e-7 && segment.end.x <= 1e-7),
  })
  expect(protectedRight.plans).not.toBeNull()
  expect(
    protectedRight.plans?.[0]?.segments
      .slice(1)
      .every((segment) => segment.start.x <= 1e-7 && segment.end.x <= 1e-7),
  ).toBe(true)
  expect(JSON.stringify({ srj, bus, plans })).toBe(snapshot)
  if (!protectedRight.plans) throw Error("Expected protected-side matching")
  const outputSrj = buildOutputSimpleRouteJson({
    inputSrj: fragmented,
    plans: protectedRight.plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: fragmented,
      outputSrj,
      plans: protectedRight.plans,
      preparedBuses: [bus],
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: fragmented,
      routedSrj: outputSrj,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
}, 30_000)
