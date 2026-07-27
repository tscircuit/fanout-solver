import {
  createMixedFootprintBenchmarkProblem,
  type MixedFootprintSpec,
} from "./create-mixed-footprint-benchmark"
import type { FanoutDatasetSample } from "./dataset-types"

interface OrientationSample {
  id: string
  name: string
  description: string
  footprints: MixedFootprintSpec[]
}

const QFN50 = "qfn50_p0.4mm"
const RESISTOR_0603 = "res0603"
const CAPACITOR_0603 = "cap0603"

const orientationSamples: OrientationSample[] = [
  {
    id: "sample001",
    name: "QFN50 0° · tangential 0603s north/south",
    description:
      "Two close, horizontal 0603 passives obstruct the north and south escape corridors around an unrotated QFN50.",
    footprints: [
      {
        componentId: "qfn50",
        footprinterString: QFN50,
        center: { x: 0, y: 0 },
        rotation: 0,
        breakoutMode: "four-side",
      },
      {
        componentId: "resistor-0603",
        footprinterString: RESISTOR_0603,
        center: { x: 0, y: 4.2 },
        rotation: 0,
        breakoutMode: "outward",
      },
      {
        componentId: "capacitor-0603",
        footprinterString: CAPACITOR_0603,
        center: { x: 0, y: -4.2 },
        rotation: 180,
        breakoutMode: "outward",
      },
    ],
  },
  {
    id: "sample002",
    name: "QFN50 90° · tangential 0603s east/west",
    description:
      "Two close, vertical 0603 passives obstruct the east and west corridors around a 90-degree QFN50.",
    footprints: [
      {
        componentId: "qfn50",
        footprinterString: QFN50,
        center: { x: 0, y: 0 },
        rotation: 90,
        breakoutMode: "four-side",
      },
      {
        componentId: "resistor-0603",
        footprinterString: RESISTOR_0603,
        center: { x: 4.2, y: 0 },
        rotation: 90,
        breakoutMode: "outward",
      },
      {
        componentId: "capacitor-0603",
        footprinterString: CAPACITOR_0603,
        center: { x: -4.2, y: 0 },
        rotation: 270,
        breakoutMode: "outward",
      },
    ],
  },
  {
    id: "sample003",
    name: "QFN50 180° · radial 0603s at NE/SW corners",
    description:
      "A resistor and capacitor point radially away from the north and east sides, offset toward opposite QFN corners to create asymmetric escape channels.",
    footprints: [
      {
        componentId: "qfn50",
        footprinterString: QFN50,
        center: { x: 0, y: 0 },
        rotation: 180,
        breakoutMode: "four-side",
      },
      {
        componentId: "resistor-0603",
        footprinterString: RESISTOR_0603,
        center: { x: -2.8, y: 4.95 },
        rotation: 90,
        breakoutMode: "outward",
      },
      {
        componentId: "capacitor-0603",
        footprinterString: CAPACITOR_0603,
        center: { x: 4.95, y: -2.8 },
        rotation: 0,
        breakoutMode: "outward",
      },
    ],
  },
  {
    id: "sample004",
    name: "QFN50 270° · radial 0603s at SE/NW corners",
    description:
      "A resistor and capacitor point radially away from the south and west sides, offset toward opposite QFN corners to reverse the asymmetric channels.",
    footprints: [
      {
        componentId: "qfn50",
        footprinterString: QFN50,
        center: { x: 0, y: 0 },
        rotation: 270,
        breakoutMode: "four-side",
      },
      {
        componentId: "resistor-0603",
        footprinterString: RESISTOR_0603,
        center: { x: 2.8, y: -4.95 },
        rotation: 90,
        breakoutMode: "outward",
      },
      {
        componentId: "capacitor-0603",
        footprinterString: CAPACITOR_0603,
        center: { x: -4.95, y: 2.8 },
        rotation: 0,
        breakoutMode: "outward",
      },
    ],
  },
]

export const fanoutDataset03: FanoutDatasetSample[] = orientationSamples.map(
  (sample) => {
    const problem = createMixedFootprintBenchmarkProblem({
      footprints: sample.footprints,
      layerCount: 2,
      boundaryMargin: 2,
      traceWidth: 0.1,
      viaDiameter: 0.25,
      viaHoleDiameter: 0.15,
      clearance: 0.1,
    })
    return {
      id: sample.id,
      name: sample.name,
      description: sample.description,
      footprintCount: sample.footprints.length,
      footprinterStrings: problem.footprinterStrings,
      simpleRouteJson: problem.simpleRouteJson,
      solverOptions: {
        compactBusTracks: false,
        componentBounds: problem.componentBounds,
        sharedBoundary: problem.sharedBoundary,
      },
      componentBounds: problem.componentBounds,
      sharedBoundary: problem.sharedBoundary,
    }
  },
)
