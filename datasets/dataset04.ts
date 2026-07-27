import {
  createMixedFootprintBenchmarkProblem,
  type MixedFootprintSpec,
} from "./create-mixed-footprint-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"

const BGA16 = "bga16_grid4x4_p0.8mm_pad0.3mm_circularpads"

const footprints: MixedFootprintSpec[] = [
  {
    componentId: "bga16",
    footprinterString: BGA16,
    center: { x: 0, y: 0 },
    rotation: 0,
    breakoutMode: "four-side",
    busGrouping: "grid-line",
  },
  {
    componentId: "resistor-north",
    footprinterString: "res0603",
    center: { x: 0, y: 3.1 },
    rotation: 0,
    breakoutMode: "outward",
    breakoutDirection: "NORTH",
  },
  {
    componentId: "capacitor-northeast",
    footprinterString: "cap0603",
    center: { x: 3.2, y: 3.2 },
    rotation: 0,
    breakoutMode: "outward",
    breakoutDirection: "EAST",
  },
  {
    componentId: "resistor-east",
    footprinterString: "res0603",
    center: { x: 3.1, y: 0 },
    rotation: 90,
    breakoutMode: "outward",
    breakoutDirection: "EAST",
  },
  {
    componentId: "capacitor-southeast",
    footprinterString: "cap0603",
    center: { x: 3.2, y: -3.2 },
    rotation: 90,
    breakoutMode: "outward",
    breakoutDirection: "SOUTH",
  },
  {
    componentId: "resistor-south",
    footprinterString: "res0603",
    center: { x: 0, y: -3.1 },
    rotation: 180,
    breakoutMode: "outward",
    breakoutDirection: "SOUTH",
  },
  {
    componentId: "capacitor-southwest",
    footprinterString: "cap0603",
    center: { x: -3.2, y: -3.2 },
    rotation: 180,
    breakoutMode: "outward",
    breakoutDirection: "WEST",
  },
  {
    componentId: "resistor-west",
    footprinterString: "res0603",
    center: { x: -3.1, y: 0 },
    rotation: 270,
    breakoutMode: "outward",
    breakoutDirection: "WEST",
  },
  {
    componentId: "capacitor-northwest",
    footprinterString: "cap0603",
    center: { x: -3.2, y: 3.2 },
    rotation: 270,
    breakoutMode: "outward",
    breakoutDirection: "NORTH",
  },
]

const problem = createMixedFootprintBenchmarkProblem({
  footprints,
  layerCount: 1,
  boundaryMargin: 1.5,
  traceWidth: 0.1,
  viaDiameter: 0.25,
  viaHoleDiameter: 0.15,
  clearance: 0.1,
  targetMargin: 1,
  targetLaneExtraClearance: 0.05,
})

export const fanoutDataset04: FanoutDatasetSample[] = [
  {
    id: "sample001",
    name: "Single-layer BGA16 surrounded by eight 0603s",
    description:
      "Routes all sixteen BGA balls—including the four inner balls—and all sixteen passive pads through one shared boundary on top copper only. Every exterior net has a distinct natural-position lane.",
    footprintCount: footprints.length,
    footprinterStrings: problem.footprinterStrings,
    simpleRouteJson: problem.simpleRouteJson,
    solverOptions: {
      componentBounds: problem.componentBounds,
      sharedBoundary: problem.sharedBoundary,
    },
    componentBounds: problem.componentBounds,
    sharedBoundary: problem.sharedBoundary,
  },
]
