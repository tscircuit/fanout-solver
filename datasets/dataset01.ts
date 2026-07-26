import {
  type BenchmarkFootprintParams,
  createFootprinterBenchmarkProblem,
} from "./create-footprinter-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"

const FOOTPRINT_CENTERS = [
  { x: 0, y: 0 },
  { x: 18, y: 6 },
  { x: -18, y: -6 },
  { x: -7, y: 18 },
  { x: 7, y: -18 },
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
      description: `Routes every pad across ${footprintCount} BGA footprint${
        footprintCount === 1 ? "" : "s"
      } to one shared breakout boundary.`,
      footprintCount,
      simpleRouteJson: problem.simpleRouteJson,
      solverOptions: {
        componentBounds: problem.componentBounds,
        sharedBoundary: problem.sharedBoundary,
      },
      componentBounds: problem.componentBounds,
      sharedBoundary: problem.sharedBoundary,
    }
  },
)
