import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { createAm62lFanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-am62l-fanout-sample"
import { createK230FanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-k230-fanout-sample"
import { createRk3308FanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-rk3308-fanout-sample"
import { dataset31Source, DATASET31_DIRECTION_CASES } from "./dataset31-source"

/** Capture the upstream TSX/core inputs; this does not run this repo's solver. */
export async function generateDataset31Inputs(
  sampleIds: readonly string[],
  outputDirectory: string,
): Promise<string[]> {
  if (sampleIds.length === 0 || new Set(sampleIds).size !== sampleIds.length)
    throw new Error("Expected distinct dataset 31 sample ids")
  const selected = sampleIds.map((id) => {
    const direction = DATASET31_DIRECTION_CASES.find((entry) => entry.id === id)
    if (!direction) throw new Error(`Unknown dataset 31 sample: ${id}`)
    return direction
  })
  await mkdir(outputDirectory, { recursive: true })
  const paths: string[] = []
  // Core's capture hook is process-local. Generate sequentially and only then
  // send the frozen constructor inputs to independent local-solver workers.
  for (const direction of selected) {
    const createSample =
      direction.chip === "am62l"
        ? createAm62lFanoutSample
        : direction.chip === "rk3308"
          ? createRk3308FanoutSample
          : createK230FanoutSample
    const sample = await createSample(direction.exitPosition)
    if (sample.id !== direction.id)
      throw new Error(`Upstream sample id mismatch: ${sample.id}`)
    const path = resolve(outputDirectory, `${sample.id}.json`)
    await writeFile(
      path,
      `${JSON.stringify(
        {
          generatedFrom: {
            ...dataset31Source,
            sample: `samples/${sample.id}.tsx`,
          },
          ...sample,
        },
        null,
        2,
      )}\n`,
    )
    paths.push(path)
  }
  return paths
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      sample: { type: "string" },
      "output-directory": {
        type: "string",
        default: "benchmark-results/inputs",
      },
    },
  })
  const ids = values.sample
    ? [values.sample]
    : DATASET31_DIRECTION_CASES.map((sample) => sample.id)
  const paths = await generateDataset31Inputs(ids, values["output-directory"]!)
  console.log(
    `Captured ${paths.length} dataset 31 inputs from ${dataset31Source.commit}`,
  )
}
