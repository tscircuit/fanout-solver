import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"
import {
  type BenchmarkFootprintParams,
  createFootprinterBenchmarkProblem,
} from "./create-footprinter-benchmark"

export interface FanoutDatasetSample {
  id: string
  name: string
  description: string
  footprintCount: number
  simpleRouteJson: SimpleRouteJson
  solverOptions: FanoutSolverOptions
}

const FOOTPRINT_CENTERS = [
  { x: 0, y: 0 },
  { x: 18, y: 0 },
  { x: -18, y: 0 },
  { x: 0, y: 18 },
  { x: 0, y: -18 },
] as const

const FOOTPRINT_GRID_SIZES = [8, 6, 6, 8, 6] as const

function createFootprints(count: number): BenchmarkFootprintParams[] {
  return FOOTPRINT_CENTERS.slice(0, count).map((center, index) => ({
    componentId: `bga-${String(index + 1).padStart(2, "0")}`,
    center: { ...center },
    gridSize: FOOTPRINT_GRID_SIZES[index],
  }))
}

export const fanoutDataset01: FanoutDatasetSample[] = Array.from(
  { length: 5 },
  (_, index) => {
    const footprintCount = index + 1
    const problem = createFootprinterBenchmarkProblem({
      footprints: createFootprints(footprintCount),
      layerCount: 4,
    })
    return {
      id: `sample${String(footprintCount).padStart(3, "0")}`,
      name: `${footprintCount} BGA footprint${footprintCount === 1 ? "" : "s"}`,
      description: `Routes every bus across ${footprintCount} independently placed BGA footprint${
        footprintCount === 1 ? "" : "s"
      } in one SimpleRouteJson.`,
      footprintCount,
      simpleRouteJson: problem.simpleRouteJson,
      solverOptions: {
        componentBounds: problem.componentBounds,
      },
    }
  },
)
