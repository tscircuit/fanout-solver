import { expect, test } from "bun:test"
import "bun-match-svg"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { buildOutputSimpleRouteJson } from "../lib/build-output"
import { matchBusPlanLengths } from "../lib/match-bus-lengths"
import { validateFanoutSolution } from "../lib/validate-fanout-solution"
import { validateRoutedCopperDrc } from "../lib/validate-routed-copper-drc"
import { visualizeSimpleRouteJson } from "../lib/visualize-simple-route-json"

import { createNarrowMeanderFixture } from "./fixtures/narrow-meander-fixture"

test("smaller 45-degree chamfers tune a long tail inside a narrow copper corridor", async () => {
  const {
    srj,
    bus,
    plans,
    params,
    prepared,
    boundary,
    layerNames,
    clearance,
    width,
    pads,
    snapshot,
  } = createNarrowMeanderFixture()
  const matched = matchBusPlanLengths(params)
  expect(matched.plans).not.toBeNull()
  if (!matched.plans) throw Error("Expected narrow corridor matching")
  expect(JSON.stringify({ srj, bus, plans })).toBe(snapshot)
  const short = matched.plans.find((p) => p.connectionIndex === 0)!
  const long = matched.plans.find((p) => p.connectionIndex === 1)!
  expect(long).toBe(plans[1])
  expect(short.length - plans[0]!.length).toBeGreaterThanOrEqual(2.4)
  expect(Math.abs(long.length - short.length)).toBeLessThanOrEqual(
    bus.maxLengthSkew + 1e-6,
  )
  expect(short.sourceObstacle).toBe(prepared[0]!.sourceObstacle)
  expect(short.sourcePoint).toBe(prepared[0]!.sourcePoint)
  expect(short.targetPoint).toBe(prepared[0]!.targetPoint)
  expect(short.via).toEqual(plans[0]!.via)
  expect(short.additionalVias).toEqual(plans[0]!.additionalVias)
  expect(short.segments[0]).toEqual(plans[0]!.segments[0])
  for (const [i, seg] of short.segments.entries()) {
    const dx = seg.end.x - seg.start.x
    const dy = seg.end.y - seg.start.y
    expect(
      Math.min(
        Math.abs(dx),
        Math.abs(dy),
        Math.abs(Math.abs(dx) - Math.abs(dy)),
      ),
    ).toBeLessThan(1e-7)
    const prev = short.segments[i - 1]
    if (prev?.layer === seg.layer) {
      const px = prev.end.x - prev.start.x
      const py = prev.end.y - prev.start.y
      expect(
        (px * dx + py * dy) / (Math.hypot(px, py) * Math.hypot(dx, dy)),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
    }
  }
  const output = buildOutputSimpleRouteJson({
    inputSrj: srj,
    plans: matched.plans,
    layerNames,
  })
  expect(
    validateFanoutSolution({
      inputSrj: srj,
      outputSrj: output,
      plans: matched.plans,
      preparedBuses: [bus],
      sharedBoundary: boundary,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, brokenOutConnectionCount: 2, issues: [] })
  expect(
    validateRoutedCopperDrc({
      inputSrj: srj,
      routedSrj: output,
      clearance,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({ valid: true, issues: [] })
  const openParams = { ...params, inputSrj: { ...srj, obstacles: pads } }
  const openResult = matchBusPlanLengths(openParams)
  expect(openResult.plans).not.toBeNull()
  const firstChamfer = openResult.plans?.[0]?.segments
    .slice(1)
    .find(
      (segment) =>
        Math.abs(segment.end.x - segment.start.x) > 1e-7 &&
        Math.abs(segment.end.y - segment.start.y) > 1e-7,
    )
  expect(firstChamfer).toBeDefined()
  expect(Math.abs(firstChamfer!.end.x - firstChamfer!.start.x)).toBeCloseTo(
    (width + clearance) / 2,
    7,
  )
  const unconstrained = {
    ...bus,
    maxLengthSkew: plans[1]!.length - plans[0]!.length + 1,
  }
  const unchanged = matchBusPlanLengths({
    ...params,
    preparedBuses: [unconstrained],
  })
  expect(unchanged.plans).toEqual(plans)
  await expect(
    getSvgFromGraphicsObject(
      visualizeSimpleRouteJson({
        ...srj,
        connections: [],
        traces: matched.plans.map((p) => p.trace),
      }),
    ),
  ).toMatchSvgSnapshot(import.meta.path)
}, 30_000)
