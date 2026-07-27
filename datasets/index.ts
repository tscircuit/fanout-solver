import type { FanoutDataset } from "./dataset-types"
import { fanoutDataset01 } from "./dataset01"
import { fanoutDataset02 } from "./dataset02"

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
]

export type { FanoutDataset, FanoutDatasetSample } from "./dataset-types"
