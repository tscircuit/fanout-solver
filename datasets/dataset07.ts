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
 * The solver currently routes none of them. Narrowing done so far:
 *
 * - dropping the 134 obstacles that belong to neighbouring parts (decouplers,
 *   flash, crystal) and keeping only the package's own 61 pads does not help
 * - supplying componentBounds plus a sharedBoundary at 0.6mm, 1.0mm or 2.0mm
 *   does not help, so it is not the missing boundary alone
 * - the synthetic RP2040-class QFN56 in dataset04 sample005 fans out all 64
 *   connections, so 0.4mm pitch by itself is not the blocker
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
      "Serialized four-layer fanout input from a dual-RP2350 handheld. Twenty-seven of the QFN60's sixty-one pads cross the breakout boundary and none of them are currently routed.",
    footprintCount: componentIds.size,
    footprinterStrings: ["RP2350A QFN60 breakout (serialized SRJ)"],
    simpleRouteJson: fixture.simpleRouteJson,
    solverOptions: fixture.solverOptions,
    componentBounds: {},
    sharedBoundary: {
      minX: RP2350A_PACKAGE_BOUNDS.minX - 0.6,
      maxX: RP2350A_PACKAGE_BOUNDS.maxX + 0.6,
      minY: RP2350A_PACKAGE_BOUNDS.minY - 0.6,
      maxY: RP2350A_PACKAGE_BOUNDS.maxY + 0.6,
    },
  },
]
