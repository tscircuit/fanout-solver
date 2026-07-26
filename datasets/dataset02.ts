import {
  type BenchmarkFootprintParams,
  createFootprinterBenchmarkProblem,
  type FootprinterBenchmarkProblem,
} from "./create-footprinter-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"

interface StressSampleSpec {
  name: string
  description: string
  footprints: BenchmarkFootprintParams[]
  addBlockedCorridor?: boolean
}

const STRESS_SAMPLE_SPECS: StressSampleSpec[] = [
  {
    name: "Dense BGA196",
    description:
      "A 14×14 BGA at 0.70 mm pitch inside a boundary only 0.80 mm beyond its courtyard.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: 0, y: 0 },
        gridSize: 14,
        pitch: 0.7,
        padDiameter: 0.26,
      },
    ],
  },
  {
    name: "Dual mixed BGA244",
    description:
      "A BGA144 and BGA100 with mixed pitches escaping opposite sides of one tight boundary.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: -12, y: -1 },
        gridSize: 12,
        pitch: 0.75,
        padDiameter: 0.28,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 12, y: 1 },
        gridSize: 10,
        pitch: 0.7,
        padDiameter: 0.26,
      },
    ],
  },
  {
    name: "Three-way BGA344",
    description:
      "A dense central BGA144 plus two BGA100 footprints sharing horizontal and vertical escape corridors.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: 0, y: 0 },
        gridSize: 12,
        pitch: 0.8,
        padDiameter: 0.3,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 16, y: 7 },
        gridSize: 10,
        pitch: 0.75,
        padDiameter: 0.28,
      },
      {
        componentId: "stress-bga-03",
        center: { x: -16, y: -7 },
        gridSize: 10,
        pitch: 0.75,
        padDiameter: 0.28,
      },
    ],
  },
  {
    name: "Four-footprint BGA408",
    description:
      "Four mixed BGA footprints and 408 pad fanouts packed around one six-layer shared boundary.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: 0, y: 0 },
        gridSize: 12,
        pitch: 0.8,
        padDiameter: 0.3,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 16, y: 7 },
        gridSize: 10,
        pitch: 0.75,
        padDiameter: 0.28,
      },
      {
        componentId: "stress-bga-03",
        center: { x: -16, y: -7 },
        gridSize: 10,
        pitch: 0.75,
        padDiameter: 0.28,
      },
      {
        componentId: "stress-bga-04",
        center: { x: -10, y: 16 },
        gridSize: 8,
        pitch: 0.7,
        padDiameter: 0.26,
      },
    ],
  },
  {
    name: "Blocked-corridor BGA472",
    description:
      "Five footprints, 472 pad fanouts, mixed pitches, and an inner1 barrier that forces a bus-layer reassignment.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: 0, y: 0 },
        gridSize: 12,
        pitch: 0.8,
        padDiameter: 0.3,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 16, y: 7 },
        gridSize: 10,
        pitch: 0.75,
        padDiameter: 0.28,
      },
      {
        componentId: "stress-bga-03",
        center: { x: -16, y: -7 },
        gridSize: 10,
        pitch: 0.75,
        padDiameter: 0.28,
      },
      {
        componentId: "stress-bga-04",
        center: { x: -10, y: 16 },
        gridSize: 8,
        pitch: 0.7,
        padDiameter: 0.26,
      },
      {
        componentId: "stress-bga-05",
        center: { x: 10, y: -16 },
        gridSize: 8,
        pitch: 0.7,
        padDiameter: 0.26,
      },
    ],
    addBlockedCorridor: true,
  },
]

function addBlockedNorthCorridor(problem: FootprinterBenchmarkProblem): void {
  const componentBounds = problem.componentBounds["stress-bga-01"]!
  problem.simpleRouteJson.obstacles.push({
    obstacleId: "stress-inner1-north-corridor-barrier",
    type: "rect",
    center: {
      x: (componentBounds.minX + componentBounds.maxX) / 2,
      y: (componentBounds.maxY + problem.sharedBoundary.maxY) / 2,
    },
    width: componentBounds.maxX - componentBounds.minX,
    height: 0.3,
    layers: ["inner1"],
    connectedTo: [],
  })
}

export const fanoutDataset02: FanoutDatasetSample[] = STRESS_SAMPLE_SPECS.map(
  (spec, index) => {
    const problem = createFootprinterBenchmarkProblem({
      boundaryMargin: 0.8,
      footprints: spec.footprints,
      layerCount: 6,
    })
    if (spec.addBlockedCorridor) addBlockedNorthCorridor(problem)

    return {
      id: `sample${String(index + 1).padStart(3, "0")}`,
      name: spec.name,
      description: spec.description,
      footprintCount: spec.footprints.length,
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
