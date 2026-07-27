import {
  createMixedFootprintBenchmarkProblem,
  type MixedFootprintSpec,
} from "./create-mixed-footprint-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"

export const BGA16 = "bga16_grid4x4_p0.8mm_pad0.3mm_circularpads"
export const BGA25 = "bga25_grid5x5_p0.8mm_pad0.3mm_circularpads"
export const BGA36 = "bga36_grid6x6_p0.8mm_pad0.3mm_circularpads"
export const BGA64 = "bga64_grid8x8_p0.8mm_pad0.3mm_circularpads"
export const RP2040_CLASS_QFN =
  "qfn56_w7_h7_p0.4mm_thermalpad3.2x3.2_startingpin(topside,rightpin)_ccw"

interface Dataset04SampleConfig {
  id: string
  name: string
  description: string
  centralComponentId: string
  centralFootprinterString: string
  centralBusGrouping: MixedFootprintSpec["busGrouping"]
  layerCount: number
  cardinalCapDistance: number
  diagonalCapDistance: number
}

const sampleConfigs: Dataset04SampleConfig[] = [
  {
    id: "sample001",
    name: "Single-layer BGA16 surrounded by eight capacitors",
    description:
      "Routes all sixteen BGA balls—including the four inner balls—and all sixteen capacitor pads through one shared boundary on top copper only.",
    centralComponentId: "bga16",
    centralFootprinterString: BGA16,
    centralBusGrouping: "grid-line",
    layerCount: 1,
    cardinalCapDistance: 3.1,
    diagonalCapDistance: 3.2,
  },
  {
    id: "sample002",
    name: "Two-layer BGA25 surrounded by eight capacitors",
    description:
      "Breaks out all twenty-five BGA balls and eight nearby 0603 capacitors through one boundary on a constrained two-layer stackup.",
    centralComponentId: "bga25",
    centralFootprinterString: BGA25,
    centralBusGrouping: "grid-line",
    layerCount: 2,
    cardinalCapDistance: 3.8,
    diagonalCapDistance: 3.9,
  },
  {
    id: "sample003",
    name: "Three-layer BGA36 surrounded by eight capacitors",
    description:
      "Breaks out a full six-by-six BGA and eight 0603 capacitors while reusing routing corridors across only three copper layers.",
    centralComponentId: "bga36",
    centralFootprinterString: BGA36,
    centralBusGrouping: "grid-line",
    layerCount: 3,
    cardinalCapDistance: 4.2,
    diagonalCapDistance: 4.3,
  },
  {
    id: "sample004",
    name: "Four-layer BGA64 surrounded by eight capacitors",
    description:
      "Breaks out all sixty-four balls of an eight-by-eight BGA plus eight 0603 capacitors without exceeding a four-layer stackup.",
    centralComponentId: "bga64",
    centralFootprinterString: BGA64,
    centralBusGrouping: "grid-line",
    layerCount: 4,
    cardinalCapDistance: 5.1,
    diagonalCapDistance: 5.2,
  },
  {
    id: "sample005",
    name: "RP2040-class QFN56 thermal pad with eight capacitors",
    description:
      "Fans out fifty-six 0.4 mm-pitch perimeter pins, the 3.2 mm exposed thermal pad, and eight surrounding 0603 capacitors on two layers.",
    centralComponentId: "rp2040-qfn56",
    centralFootprinterString: RP2040_CLASS_QFN,
    centralBusGrouping: "individual",
    layerCount: 2,
    cardinalCapDistance: 5.7,
    diagonalCapDistance: 5.8,
  },
]

const capPlacements = [
  {
    suffix: "north",
    xSign: 0,
    ySign: 1,
    rotation: 0,
    direction: "NORTH",
  },
  {
    suffix: "northeast",
    xSign: 1,
    ySign: 1,
    rotation: 0,
    direction: "EAST",
  },
  {
    suffix: "east",
    xSign: 1,
    ySign: 0,
    rotation: 90,
    direction: "EAST",
  },
  {
    suffix: "southeast",
    xSign: 1,
    ySign: -1,
    rotation: 90,
    direction: "SOUTH",
  },
  {
    suffix: "south",
    xSign: 0,
    ySign: -1,
    rotation: 180,
    direction: "SOUTH",
  },
  {
    suffix: "southwest",
    xSign: -1,
    ySign: -1,
    rotation: 180,
    direction: "WEST",
  },
  {
    suffix: "west",
    xSign: -1,
    ySign: 0,
    rotation: 270,
    direction: "WEST",
  },
  {
    suffix: "northwest",
    xSign: -1,
    ySign: 1,
    rotation: 270,
    direction: "NORTH",
  },
] as const

function createSample(config: Dataset04SampleConfig): FanoutDatasetSample {
  const footprints: MixedFootprintSpec[] = [
    {
      componentId: config.centralComponentId,
      footprinterString: config.centralFootprinterString,
      center: { x: 0, y: 0 },
      rotation: 0,
      breakoutMode: "four-side",
      busGrouping: config.centralBusGrouping,
    },
    ...capPlacements.map((placement) => {
      const distance =
        placement.xSign !== 0 && placement.ySign !== 0
          ? config.diagonalCapDistance
          : config.cardinalCapDistance
      return {
        componentId: `capacitor-${placement.suffix}`,
        footprinterString: "cap0603",
        center: {
          x: placement.xSign * distance,
          y: placement.ySign * distance,
        },
        rotation: placement.rotation,
        breakoutMode: "outward" as const,
        breakoutDirection: placement.direction,
      }
    }),
  ]
  const problem = createMixedFootprintBenchmarkProblem({
    footprints,
    layerCount: config.layerCount,
    boundaryMargin: 1.5,
    traceWidth: 0.1,
    viaDiameter: 0.25,
    viaHoleDiameter: 0.15,
    clearance: 0.1,
    targetMargin: 1,
    targetLaneExtraClearance: 0.05,
  })

  return {
    id: config.id,
    name: config.name,
    description: config.description,
    footprintCount: footprints.length,
    footprinterStrings: problem.footprinterStrings,
    simpleRouteJson: problem.simpleRouteJson,
    solverOptions: {
      componentBounds: problem.componentBounds,
      sharedBoundary: problem.sharedBoundary,
    },
    componentBounds: problem.componentBounds,
    sharedBoundary: problem.sharedBoundary,
  }
}

export const fanoutDataset04: FanoutDatasetSample[] =
  sampleConfigs.map(createSample)
