import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { Bounds, FanoutSolverOptions } from "lib/types"

export interface FanoutDatasetSample {
  id: string
  name: string
  description: string
  footprintCount: number
  simpleRouteJson: SimpleRouteJson
  solverOptions: FanoutSolverOptions
  componentBounds: Readonly<Record<string, Bounds>>
  sharedBoundary: Bounds
}

export interface FanoutDataset {
  id: string
  name: string
  description: string
  samples: FanoutDatasetSample[]
}
