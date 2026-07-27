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
    name: "Stress",
    description:
      "Close 0.4 mm-pitch BGA40 fanouts on two routing layers with 4/4 mil copper rules, bus-atomic HDI microvias, four-pad corner interstices, and compact 45-degree bend-ins.",
    samples: fanoutDataset02,
  },
]

export type { FanoutDataset, FanoutDatasetSample } from "./dataset-types"
