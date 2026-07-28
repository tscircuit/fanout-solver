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
      "Exact serialized single-layer fanout input from the clad1 RP2040 assembly. The current solver routes 35 of 132 connections through the shared component-area boundary.",
    footprintCount: componentIds.size,
    footprinterStrings: ["clad1 RP2040 assembly (serialized SRJ)"],
    simpleRouteJson: fixture.simpleRouteJson,
    solverOptions: fixture.solverOptions,
    componentBounds: {},
    sharedBoundary,
  },
]
