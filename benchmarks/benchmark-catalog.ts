import { fanoutDatasets } from "../datasets"
import { srj19FanoutSamples } from "../datasets/srj19"
import { srj29FanoutSamples } from "../datasets/srj29"
import type { BenchmarkSample } from "./benchmark-types"

export const benchmarkSamples: BenchmarkSample[] = [
  ...fanoutDatasets.flatMap((dataset) =>
    dataset.samples.map((sample) => ({
      dataset: dataset.id,
      id: sample.id,
      simpleRouteJson: sample.simpleRouteJson,
      solverOptions: sample.solverOptions,
      requireOriginalEndpoints:
        sample.solverOptions?.completeOriginalEndpoints === true,
    })),
  ),
  ...srj19FanoutSamples.map((sample) => ({
    ...sample,
    dataset: "srj19",
    requireOriginalEndpoints: false,
  })),
  ...srj29FanoutSamples.map((sample) => ({
    ...sample,
    dataset: "srj29",
    requireOriginalEndpoints: true,
  })),
]

const keys = benchmarkSamples.map((sample) => `${sample.dataset}/${sample.id}`)
if (new Set(keys).size !== keys.length)
  throw new Error("Duplicate benchmark sample")

export function selectBenchmarkSamples(options: {
  dataset?: string
  sample?: string
  limit?: number
}): BenchmarkSample[] {
  const datasetIds =
    options.dataset && options.dataset !== "all"
      ? options.dataset.split(",")
      : undefined
  for (const id of datasetIds ?? []) {
    if (!benchmarkSamples.some((sample) => sample.dataset === id))
      throw new Error(`Unknown dataset: ${id}`)
  }
  let samples = benchmarkSamples.filter(
    (sample) =>
      (!datasetIds || datasetIds.includes(sample.dataset)) &&
      (!options.sample ||
        sample.id === options.sample ||
        `${sample.dataset}/${sample.id}` === options.sample),
  )
  if (samples.length === 0)
    throw new Error("No benchmark samples match the selection")
  if (options.limit !== undefined) samples = samples.slice(0, options.limit)
  return samples
}
