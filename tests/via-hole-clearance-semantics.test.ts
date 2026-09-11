import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import {
  getViaHoleToHoleClearance,
  viaCentersRepresentSamePhysicalHole,
} from "../lib/via-clearance"

test("drill clearance is explicit and coincident records share one hole", () => {
  expect(getViaHoleToHoleClearance({} as SimpleRouteJson)).toBe(0)
  expect(
    getViaHoleToHoleClearance({
      minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
    } as unknown as SimpleRouteJson),
  ).toBe(0.254)

  expect(
    viaCentersRepresentSamePhysicalHole(
      { x: 1.25, y: -0.75 },
      { x: 1.25, y: -0.75 },
    ),
  ).toBe(true)
  expect(
    viaCentersRepresentSamePhysicalHole(
      { x: 1.25, y: -0.75 },
      { x: 1.2501, y: -0.75 },
    ),
  ).toBe(false)
})
