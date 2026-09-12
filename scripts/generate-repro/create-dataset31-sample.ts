import { createAm3352FanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-am3352-fanout-sample"
import { createAm62lFanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-am62l-fanout-sample"
import { createImx6ullFanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-imx6ull-fanout-sample"
import { createK230FanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-k230-fanout-sample"
import { createRk3308FanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-rk3308-fanout-sample"
import { createT113s3FanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-t113s3-fanout-sample"
import type { DATASET31_DIRECTION_CASES } from "./dataset31-source"

type Dataset31DirectionCase = (typeof DATASET31_DIRECTION_CASES)[number]

export type Dataset31Sample =
  | Awaited<ReturnType<typeof createAm62lFanoutSample>>
  | Awaited<ReturnType<typeof createRk3308FanoutSample>>
  | Awaited<ReturnType<typeof createK230FanoutSample>>
  | Awaited<ReturnType<typeof createImx6ullFanoutSample>>
  | Awaited<ReturnType<typeof createT113s3FanoutSample>>
  | Awaited<ReturnType<typeof createAm3352FanoutSample>>

export async function createDataset31Sample(
  direction: Pick<Dataset31DirectionCase, "chip" | "exitPosition" | "id">,
): Promise<Dataset31Sample> {
  const sample = await (direction.chip === "am62l"
    ? createAm62lFanoutSample(direction.exitPosition)
    : direction.chip === "rk3308"
      ? createRk3308FanoutSample(direction.exitPosition)
      : direction.chip === "k230"
        ? createK230FanoutSample(direction.exitPosition)
        : direction.chip === "imx6ull"
          ? createImx6ullFanoutSample(direction.exitPosition)
          : direction.chip === "t113s3"
            ? createT113s3FanoutSample(direction.exitPosition)
            : createAm3352FanoutSample(direction.exitPosition))
  if (sample.id !== direction.id)
    throw new Error(`Upstream sample id mismatch: ${sample.id}`)
  return sample
}
