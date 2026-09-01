import { expect, test } from "bun:test"
import { shouldUseDenseBoundaryFirstFallback } from "../lib/fanout-solver"

const northRootProbes = [
  { failed: true, planCount: 0 },
  { failed: true, planCount: 0 },
  { failed: true, planCount: 9 },
]

test("selects boundary-first when every dense all-top root order fails", () => {
  expect(
    shouldUseDenseBoundaryFirstFallback({
      totalBoundaryConnectionCount: 33,
      planeBusCount: 102,
      boundaryExitEdges: Array(9).fill("top"),
      rootProbes: northRootProbes,
    }),
  ).toBe(true)
})

test("does not extend the all-top fallback to the other orbit edges", () => {
  for (const edge of ["right", "bottom", "left"] as const) {
    expect(
      shouldUseDenseBoundaryFirstFallback({
        totalBoundaryConnectionCount: 33,
        planeBusCount: 102,
        boundaryExitEdges: Array(9).fill(edge),
        rootProbes: northRootProbes,
      }),
    ).toBe(false)
  }
})

test("preserves the orientation-independent catastrophic-root fallback", () => {
  expect(
    shouldUseDenseBoundaryFirstFallback({
      totalBoundaryConnectionCount: 24,
      planeBusCount: 1,
      boundaryExitEdges: ["right"],
      rootProbes: [
        { failed: true, planCount: 0 },
        { failed: true, planCount: 1 },
      ],
    }),
  ).toBe(true)
})

test("requires a dense mixed-termination problem and failed root orders", () => {
  expect(
    shouldUseDenseBoundaryFirstFallback({
      totalBoundaryConnectionCount: 23,
      planeBusCount: 102,
      boundaryExitEdges: ["top"],
      rootProbes: northRootProbes,
    }),
  ).toBe(false)
  expect(
    shouldUseDenseBoundaryFirstFallback({
      totalBoundaryConnectionCount: 33,
      planeBusCount: 0,
      boundaryExitEdges: ["top"],
      rootProbes: northRootProbes,
    }),
  ).toBe(false)
  expect(
    shouldUseDenseBoundaryFirstFallback({
      totalBoundaryConnectionCount: 33,
      planeBusCount: 102,
      boundaryExitEdges: ["top"],
      rootProbes: [{ failed: false, planCount: 33 }],
    }),
  ).toBe(false)
})
