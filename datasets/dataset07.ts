import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { Bounds, FanoutSolverOptions } from "lib/types"
import rp2350aBreakoutFixture from "./fixtures/rp2350a-breakout-with-decoupling-ring.json"
import type { FanoutDatasetSample } from "./dataset-types"

/**
 * Serialized fanout input captured from @tscircuit/core's `<breakout>` around
 * an RP2350A and its complete decoupling ring, on a four-layer handheld.
 *
 * The interesting property is not that it fails, it is *how* it fails: giving
 * the fanout more room makes it strictly worse. Widening the shared boundary
 * without changing anything else takes the result from 13 of 23 connections
 * down to zero, and it stays at zero however much further it is widened.
 *
 * That rules out "not enough space" as the explanation -- extra space is
 * exactly what a space-limited problem would benefit from.
 */
const fixture = rp2350aBreakoutFixture as unknown as {
  simpleRouteJson: SimpleRouteJson
  solverOptions: FanoutSolverOptions
  sharedBoundary: Bounds
}

export const rp2350aBreakoutFanoutInput = fixture

/** Boundary core resolved for the breakout: the tight bbox of its contents. */
export const RP2350A_BREAKOUT_BOUNDARY = fixture.sharedBoundary

export const growBounds = (bounds: Bounds, by: number): Bounds => ({
  minX: bounds.minX - by,
  maxX: bounds.maxX + by,
  minY: bounds.minY - by,
  maxY: bounds.maxY + by,
})

const componentIds = new Set(
  fixture.simpleRouteJson.obstacles.flatMap((obstacle) =>
    obstacle.componentId ? [obstacle.componentId] : [],
  ),
)

const createSample = (
  id: string,
  name: string,
  description: string,
  grownBy: number,
): FanoutDatasetSample => ({
  id,
  name,
  description,
  footprintCount: componentIds.size,
  footprinterStrings: [
    "RP2350A QFN60 + decoupling ring breakout (serialized SRJ)",
  ],
  simpleRouteJson: fixture.simpleRouteJson,
  solverOptions: {
    ...fixture.solverOptions,
    sharedBoundary: growBounds(RP2350A_BREAKOUT_BOUNDARY, grownBy),
  },
  componentBounds: {},
  sharedBoundary: growBounds(RP2350A_BREAKOUT_BOUNDARY, grownBy),
})

export const fanoutDataset07: FanoutDatasetSample[] = [
  createSample(
    "sample001",
    "As resolved by core",
    "The breakout boundary core resolved: the tight bounding box of the QFN plus its decoupling ring. Routes 13 of 23 connections.",
    0,
  ),
  createSample(
    "sample002",
    "Boundary widened 0.6mm",
    "The same problem with 0.6mm more room on every side. Routes 0 of 23 -- strictly worse than the tighter boundary above.",
    0.6,
  ),
  createSample(
    "sample003",
    "Boundary widened 3mm",
    "3mm more room on every side, well clear of every pad. Still routes 0 of 23.",
    3,
  ),
]
