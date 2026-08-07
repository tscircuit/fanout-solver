import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"
import rp2350aBreakoutFixture from "./fixtures/rp2350a-qfn60-breakout-fanout.json"
import type { FanoutDatasetSample } from "./dataset-types"

/**
 * Serialized fanout input captured from @tscircuit/core's `<breakout>` around
 * an RP2350A on a four-layer handheld board.
 *
 * The package is a QFN60: 0.4mm pitch, 7x7mm body, 3.4mm centre thermal pad.
 * Only 27 of its 61 pads are connected -- the rest are power, ground or unused
 * -- and every one of those 27 has to cross the breakout boundary.
 *
 * This capture originally routed 0/27 and pinned two solver bugs:
 *
 * - `srj.bounds` is exactly the pad extent (core allots the breakout region no
 *   larger than the footprint), but the inferred shared boundary added a
 *   pitch-derived margin, so every exit point fell outside `srj.bounds` and
 *   every plan was rejected
 * - fourteen of the captured breakout targets are a placeholder at the package
 *   centre `(0, 0)`, so displacement-based direction inference sent those
 *   buses across the package instead of out of their own edge
 *
 * Note that core supplies neither `sharedBoundary` nor `componentBounds` here;
 * its options are only `{ borderDistribution, compactBusTracks }`.
 */
const fixture = rp2350aBreakoutFixture as unknown as {
  simpleRouteJson: SimpleRouteJson
  solverOptions: FanoutSolverOptions
}

export const rp2350aBreakoutFanoutInput = fixture

const componentIds = new Set(
  fixture.simpleRouteJson.obstacles.flatMap((obstacle) =>
    obstacle.componentId ? [obstacle.componentId] : [],
  ),
)

/** Pad extent of the QFN60, derived from the connected pad centres. */
export const RP2350A_PACKAGE_BOUNDS = (() => {
  const points = fixture.simpleRouteJson.connections.flatMap(
    (connection) => connection.pointsToConnect,
  )
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
})()

export const fanoutDataset07: FanoutDatasetSample[] = [
  {
    id: "sample001",
    name: "RP2350A QFN60 breakout reproduction",
    description:
      "Serialized four-layer fanout input from a dual-RP2350 handheld. Twenty-seven of the QFN60's sixty-one pads cross a breakout boundary that is no larger than the footprint itself.",
    footprintCount: componentIds.size,
    footprinterStrings: ["RP2350A QFN60 breakout (serialized SRJ)"],
    simpleRouteJson: fixture.simpleRouteJson,
    solverOptions: fixture.solverOptions,
    componentBounds: {},
    // The routable area is the breakout region itself, so the boundary the
    // solver infers (and exits on) is srj.bounds.
    sharedBoundary: { ...fixture.simpleRouteJson.bounds },
  },
]
