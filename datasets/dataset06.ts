import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"
import clad1Rp2040Fixture from "./fixtures/clad1-rp2040-fanout.json"
import type { FanoutDatasetSample } from "./dataset-types"

const fixture = clad1Rp2040Fixture as unknown as {
  simpleRouteJson: SimpleRouteJson
  solverOptions: FanoutSolverOptions
}

const sharedBoundary = fixture.solverOptions.sharedBoundary!
const componentIds = new Set(
  fixture.simpleRouteJson.obstacles.flatMap((obstacle) =>
    obstacle.componentId ? [obstacle.componentId] : [],
  ),
)

export const fanoutDataset06: FanoutDatasetSample[] = [
  {
    id: "sample001",
    name: "clad1 RP2040 shared-boundary reproduction",
    description:
      "Exact serialized single-layer fanout input from the clad1 RP2040 assembly. Same-connection copper awareness raises the partial route from 35 to 37 of 132 connections; completing the fixture still requires non-monotone escapes and electrically connected multi-terminal merging.",
    footprintCount: componentIds.size,
    footprinterStrings: ["clad1 RP2040 assembly (serialized SRJ)"],
    simpleRouteJson: fixture.simpleRouteJson,
    solverOptions: fixture.solverOptions,
    componentBounds: {},
    sharedBoundary,
  },
]
