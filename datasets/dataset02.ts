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

const PITCH = 0.4
const PAD_DIAMETER = 0.2
const VIA_DIAMETER = 0.15
const VIA_HOLE_DIAMETER = 0.1
const TRACE_WIDTH = 0.1
const CLEARANCE = 0.1
const BOUNDARY_MARGIN = 4
const ROW_COUNT = 4
const COLUMN_COUNT = 10
const MAX_CONNECTIONS_PER_BUS = 10

const STRESS_SAMPLE_SPECS: StressSampleSpec[] = [
  {
    name: "0.4 mm pitch two-layer BGA40",
    description:
      "A 10×4 BGA with JLCPCB 0.10 mm trace/space rules. Twenty inner pads use corner-interstitial HDI microvias; outer buses remain via-free.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: 0, y: 0 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
  {
    name: "Close dual 0.4 mm BGA40",
    description:
      "Two BGA40 footprints sit only 0.6 mm pad-edge to pad-edge and escape through one shared two-layer boundary.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: -2.2, y: -0.3 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 2.2, y: 0.3 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
  {
    name: "Staggered triple 0.4 mm BGA40",
    description:
      "Three closely staggered BGA40 footprints compact every 10-trace bus into the same 1.8 mm routing envelope before leaving a shared boundary.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: -4.4, y: -0.4 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-02",
        center: { x: 0, y: 0.4 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-03",
        center: { x: 4.4, y: -0.4 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
  {
    name: "Close four-footprint 0.4 mm BGA40 corridor",
    description:
      "Four BGA40s alternate vertically while remaining 0.6 mm apart horizontally, stressing shared top and bottom breakout corridors.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: -6.6, y: -0.55 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-02",
        center: { x: -2.2, y: 0.55 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-03",
        center: { x: 2.2, y: -0.55 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-04",
        center: { x: 6.6, y: 0.55 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
    ],
  },
  {
    name: "Five close 0.4 mm BGA40s",
    description:
      "Five tightly staggered BGA40 footprints route 200 pads on two copper layers with bus-atomic microvias and compact 45-degree bend-ins.",
    footprints: [
      {
        componentId: "stress-bga-01",
        center: { x: -8.8, y: -0.55 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-02",
        center: { x: -4.4, y: 0.55 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-03",
        center: { x: 0, y: -0.55 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-04",
        center: { x: 4.4, y: 0.55 },
        gridSize: 4,
        pitch: PITCH,
        padDiameter: PAD_DIAMETER,
      },
      {
        componentId: "stress-bga-05",
        center: { x: 8.8, y: -0.55 },
        gridSize: 4,
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
      footprints: spec.footprints.map((footprint) => ({
        ...footprint,
        rowCount: ROW_COUNT,
        columnCount: COLUMN_COUNT,
      })),
      layerCount: 2,
      busDirectionMode: "vertical-split",
      maxConnectionsPerBus: MAX_CONNECTIONS_PER_BUS,
      traceWidth: TRACE_WIDTH,
      viaDiameter: VIA_DIAMETER,
      viaHoleDiameter: VIA_HOLE_DIAMETER,
    })

    return {
      id: `sample${String(index + 1).padStart(3, "0")}`,
      name: spec.name,
      description: spec.description,
      footprintCount: spec.footprints.length,
      footprinterStrings: problem.footprinterStrings,
      simpleRouteJson: problem.simpleRouteJson,
      solverOptions: {
        compactBusTracks: true,
        componentBounds: problem.componentBounds,
        sharedBoundary: problem.sharedBoundary,
      },
      componentBounds: problem.componentBounds,
      sharedBoundary: problem.sharedBoundary,
    }
  },
)
