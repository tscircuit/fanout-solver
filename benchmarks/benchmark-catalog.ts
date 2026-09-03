import { FANOUT_DIRECTION_CASES } from "../scripts/generate-repro/dataset31-source"

export const benchmarkSamples = FANOUT_DIRECTION_CASES.map((sample) => ({
  dataset: "dataset31" as const,
  id: sample.id,
  exitPosition: sample.exitPosition,
}))

const keys = benchmarkSamples.map((sample) => `${sample.dataset}/${sample.id}`)
if (new Set(keys).size !== keys.length)
  throw new Error("Duplicate benchmark sample")

export function selectBenchmarkSamples(options: {
  dataset?: string
  sample?: string
  limit?: number
}) {
  if (
    options.dataset !== undefined &&
    !["31", "dataset31", "fanout31", "dataset-fanout31-am62l"].includes(
      options.dataset,
    )
  )
    throw new Error("Only dataset31 is supported by this benchmark")
  let samples = benchmarkSamples.filter(
    (sample) =>
      !options.sample ||
      sample.id === options.sample ||
      `${sample.dataset}/${sample.id}` === options.sample,
  )
  if (samples.length === 0)
    throw new Error("No benchmark samples match the selection")
  if (options.limit !== undefined) samples = samples.slice(0, options.limit)
  return samples
}
