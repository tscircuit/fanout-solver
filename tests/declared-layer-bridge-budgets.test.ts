import { expect, test } from "bun:test"
import { routeDeclaredLayerBridgeSteps } from "../lib/route-declared-layer-bridge"
import { makeDeclaredLayerBridgeFixture } from "./fixtures/declared-layer-bridge-fixture"

test("rejects non-finite bridge budgets and unsupported policies before routing", () => {
  const f = makeDeclaredLayerBridgeFixture()
  const base = { ...f.params, sourcePlans: f.sourcePlans }
  const fields = {
    maximumSearches: 2048,
    maximumDirectOrders: 48,
    maximumBridgePairs: 256,
    maximumSourceSites: 256,
    maximumPartialCandidates: 3,
  }
  for (const blockedOrderPolicy of [
    "prioritize-blocked",
    "append-blocked",
  ] as const) {
    for (const [field, max] of Object.entries(fields))
      for (const value of [NaN, Infinity, -Infinity, -1, 0.5, max + 1])
        expect(() =>
          routeDeclaredLayerBridgeSteps({
            ...base,
            blockedOrderPolicy,
            [field]: value,
          }).next(),
        ).toThrow("Bridge search limit")
    for (const minimumPrimaryReturnSteps of [
      NaN,
      Infinity,
      -Infinity,
      -1,
      0,
      0.5,
      8,
    ])
      expect(() =>
        routeDeclaredLayerBridgeSteps({
          ...base,
          blockedOrderPolicy,
          minimumPrimaryReturnSteps,
        }).next(),
      ).toThrow("Primary return steps")
    expect(
      routeDeclaredLayerBridgeSteps({
        ...base,
        blockedOrderPolicy,
        maximumSearches: 0,
      }).next(),
    ).toEqual({ done: true, value: null })
  }
  expect(() =>
    routeDeclaredLayerBridgeSteps({
      ...base,
      blockedOrderPolicy: "unknown" as never,
    }).next(),
  ).toThrow("Unsupported blocked-terminal")
})
