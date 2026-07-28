import type { FanoutDataset } from "./dataset-types"
import { fanoutDataset01 } from "./dataset01"
import { fanoutDataset02 } from "./dataset02"
import { fanoutDataset03 } from "./dataset03"
import { fanoutDataset04 } from "./dataset04"
import { fanoutDataset05 } from "./dataset05"
import { fanoutDataset06 } from "./dataset06"

export const fanoutDatasets: FanoutDataset[] = [
  {
    id: "dataset01",
    name: "Baseline",
    description:
      "One through five BGA footprints with every pad routed to one shared boundary.",
    samples: fanoutDataset01,
  },
  {
    id: "dataset02",
    name: "BGA400",
    description:
      "A complete four-layer, four-sided 20×20 BGA400 breakout with repeated depth bands, bus-atomic standard vias, and 4/4 mil copper rules.",
    samples: fanoutDataset02,
  },
  {
    id: "dataset03",
    name: "QFN50 + 0603",
    description:
      "Two-layer mixed-footprint fanout samples with a 0.4 mm-pitch QFN50 closely surrounded by a two-pad 0603 resistor and capacitor in multiple package orientations.",
    samples: fanoutDataset03,
  },
  {
    id: "dataset04",
    name: "Single-layer push-and-shove + 8×caps",
    description:
      "Larger BGAs and an RP2040-class QFN56 package, each surrounded at all eight compass positions by cap0603 footprints and escaped through one shared boundary using top-copper push-and-shove bends.",
    samples: fanoutDataset04,
  },
  {
    id: "dataset05",
    name: "RK3588 plane-aware breakout",
    description:
      "An exact 1,088-ball RK3588 FCBGA map with local ground and power plane terminations plus a four-routing-layer shared-boundary signal breakout.",
    samples: fanoutDataset05,
  },
  {
    id: "dataset06",
    name: "clad1 RP2040 reproduction",
    description:
      "The exact 132-connection, single-layer mixed-footprint shared-boundary fanout from the clad1 RP2040 board.",
    samples: fanoutDataset06,
  },
]

export type { FanoutDataset, FanoutDatasetSample } from "./dataset-types"
