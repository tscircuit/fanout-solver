import {
  createMixedFootprintBenchmarkProblem,
  type MixedFootprintSpec,
} from "./create-mixed-footprint-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"
import type { FanoutBorderTarget, FanoutBusSpec } from "lib/types"

export const BGA16 = "bga16_grid4x4_p0.8mm_pad0.3mm_circularpads"
export const BGA25 = "bga25_grid5x5_p1.75mm_pad0.3mm_circularpads"
export const BGA36 = "bga36_grid6x6_p1.5mm_pad0.3mm_circularpads"
export const BGA64 = "bga64_grid8x8_p1.5mm_pad0.3mm_circularpads"
export const RP2040_CLASS_QFN =
  "qfn56_w7.8_h7.8_p0.4mm_pw0.23mm_pl0.8mm_thermalpad3.2x3.2_startingpin(topside,rightpin)_ccw"

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
    diagonalCapDistance: 4.6,
  },
  {
    id: "sample002",
    name: "Single-layer BGA25 push-and-shove breakout with eight capacitors",
    description:
      "Pushes and shoves all twenty-five BGA traces around eight 0603 capacitors through one shared boundary on top copper only.",
    centralComponentId: "bga25",
    centralFootprinterString: BGA25,
    centralBusGrouping: "grid-line",
    layerCount: 1,
    cardinalCapDistance: 7.375,
    diagonalCapDistance: 9.375,
  },
  {
    id: "sample003",
    name: "Single-layer BGA36 push-and-shove breakout with eight capacitors",
    description:
      "Pushes and shoves a full six-by-six BGA plus eight 0603 capacitors through ordered same-layer routing corridors.",
    centralComponentId: "bga36",
    centralFootprinterString: BGA36,
    centralBusGrouping: "grid-line",
    layerCount: 1,
    cardinalCapDistance: 7.5,
    diagonalCapDistance: 9.5,
  },
  {
    id: "sample004",
    name: "Single-layer BGA64 push-and-shove breakout with eight capacitors",
    description:
      "Breaks out all sixty-four balls of an eight-by-eight BGA plus eight 0603 capacitors using top-layer push-and-shove bends only.",
    centralComponentId: "bga64",
    centralFootprinterString: BGA64,
    centralBusGrouping: "grid-line",
    layerCount: 1,
    cardinalCapDistance: 9,
    diagonalCapDistance: 11,
  },
  {
    id: "sample005",
    name: "RP2040-class QFN56 thermal pad with eight capacitors",
    description:
      "Fans out all fifty-six 0.4 mm-pitch perimeter pins, the enclosed thermal pad, and eight surrounding 0603 capacitors on top copper. The thermal-pad trace uses a 45-degree package-corner channel between the two outer perimeter pads.",
    centralComponentId: "rp2040-qfn56",
    centralFootprinterString: RP2040_CLASS_QFN,
    centralBusGrouping: "individual",
    layerCount: 1,
    cardinalCapDistance: 5.7,
    diagonalCapDistance: 7.7,
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

const preferredCornerByComponentId: Readonly<
  Record<string, FanoutBorderTarget>
> = {
  "capacitor-northwest": "top-left",
  "capacitor-northeast": "top-right",
  "capacitor-southeast": "bottom-right",
  "capacitor-southwest": "bottom-left",
}

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
  problem.simpleRouteJson.buses = problem.simpleRouteJson.buses?.map((bus) => {
    const componentId = bus.busId.split(":")[0]!
    const preferredExit = preferredCornerByComponentId[componentId]
    return preferredExit ? { ...bus, preferredExit } : bus
  }) as FanoutBusSpec[]

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
      escapeLayers: ["top"],
      singleLayerPushAndShove: true,
      borderDistribution: "even",
    },
    componentBounds: problem.componentBounds,
    sharedBoundary: problem.sharedBoundary,
  }
}

export const fanoutDataset04: FanoutDatasetSample[] =
  sampleConfigs.map(createSample)
