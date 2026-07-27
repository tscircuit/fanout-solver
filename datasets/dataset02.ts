import {
  type BenchmarkFootprintParams,
  createFootprinterBenchmarkProblem,
} from "./create-footprinter-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"

interface StressSampleSpec {
  name: string
  description: string
  footprints: BenchmarkFootprintParams[]
}

const PITCH = 1
const PAD_DIAMETER = 0.6
const VIA_DIAMETER = 0.4
const VIA_HOLE_DIAMETER = 0.2
const TRACE_WIDTH = 0.06
const CLEARANCE = 0.03
const BOUNDARY_MARGIN = 8

const STRESS_SAMPLE_SPECS: StressSampleSpec[] = [
  {
    name: "Two-layer interstitial BGA100",
    description:
      "A 10×10 BGA whose 0.40 mm vias cannot fit between adjacent 0.60 mm pads and must use four-pad corner interstices.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: 0, y: 0 },
        gridSize: 10,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
  {
    name: "Opposed dual BGA200",
    description:
      "Two dense BGA100 footprints escape in opposite directions on one bottom routing layer.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: -8, y: 0 },
        gridSize: 10,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 8, y: 0 },
        gridSize: 10,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
  {
    name: "Four-sided triple BGA228",
    description:
      "Two side BGA64s and a central BGA100 share one boundary, forcing simultaneous left, right, north, and south spreading.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: -16, y: 0 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 0, y: 0 },
        gridSize: 10,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-03",
        center: { x: 16, y: 0 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
  {
    name: "Quadrant BGA256",
    description:
      "Four BGA64 footprints push 256 interstitial-via fanouts through the top and bottom edges of a shared two-layer boundary.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: -12, y: -16 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 12, y: -16 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-03",
        center: { x: -12, y: 16 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-04",
        center: { x: 12, y: 16 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
  {
    name: "Five-footprint two-layer BGA356",
    description:
      "A central BGA100 plus four BGA64s require 356 collision-free interstitial vias and heavily spread bottom-layer escapes.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: 0, y: 0 },
        gridSize: 10,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-02",
        center: { x: -16, y: -10 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-03",
        center: { x: 16, y: -10 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-04",
        center: { x: -16, y: 10 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-05",
        center: { x: 16, y: 10 },
        gridSize: 8,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
]

export const fanoutDataset02: FanoutDatasetSample[] = STRESS_SAMPLE_SPECS.map(
  (spec, index) => {
    const problem = createFootprinterBenchmarkProblem({
      boundaryMargin: BOUNDARY_MARGIN,
      clearance: CLEARANCE,
      footprints: spec.footprints,
      layerCount: 2,
      traceWidth: TRACE_WIDTH,
      viaDiameter: VIA_DIAMETER,
      viaHoleDiameter: VIA_HOLE_DIAMETER,
    })

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
