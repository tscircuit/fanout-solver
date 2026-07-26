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
      "Dense mixed-pitch BGAs, tight shared boundaries, six layers, and a blocked-corridor layer reassignment.",
    samples: fanoutDataset02,
  },
]

export type { FanoutDataset, FanoutDatasetSample } from "./dataset-types"
