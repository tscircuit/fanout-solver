import { expect, test } from "bun:test"
import {
  benchmarkSamples,
  selectBenchmarkSamples,
} from "../benchmarks/benchmark-catalog"
import { fanoutDatasets } from "../datasets"
import { srj19FanoutSamples } from "../datasets/srj19"
import { srj29FanoutSamples } from "../datasets/srj29"

test("benchmark discovers every registered and external sample without dropping constraints", () => {
  expect(benchmarkSamples).toHaveLength(
    fanoutDatasets.reduce(
      (count, dataset) => count + dataset.samples.length,
      0,
    ) +
      srj19FanoutSamples.length +
      srj29FanoutSamples.length,
  )
  expect(
    new Set(benchmarkSamples.map((sample) => `${sample.dataset}/${sample.id}`))
      .size,
  ).toBe(benchmarkSamples.length)
  const am62l = selectBenchmarkSamples({ dataset: "dataset08" })[0]!
  expect(am62l.simpleRouteJson.connections).toHaveLength(135)
  expect(am62l.simpleRouteJson.obstacles).toHaveLength(573)
  expect(am62l.requireOriginalEndpoints).toBe(false)
  expect(
    selectBenchmarkSamples({ dataset: "srj19,srj29", sample: "sample001" }),
  ).toHaveLength(2)
  expect(
    selectBenchmarkSamples({ sample: "srj29/sample001" })[0]!
      .requireOriginalEndpoints,
  ).toBe(true)
  expect(selectBenchmarkSamples({ limit: 2 })).toHaveLength(2)
  expect(() => selectBenchmarkSamples({ dataset: "missing" })).toThrow(
    "Unknown dataset",
  )
  expect(() => selectBenchmarkSamples({ sample: "missing" })).toThrow(
    "No benchmark samples",
  )
  // The worker transport must not silently drop callbacks or non-JSON input.
  for (const sample of benchmarkSamples)
    expect(JSON.parse(JSON.stringify(sample))).toEqual(sample)
})
