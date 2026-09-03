import { expect, test } from "bun:test"
import {
  benchmarkSamples,
  selectBenchmarkSamples,
} from "../benchmarks/benchmark-catalog"
import { FANOUT_DIRECTION_CASES } from "../scripts/generate-repro/dataset31-source"

test("benchmark includes exactly the 12 upstream dataset 31 cases and rejects other datasets", () => {
  expect(benchmarkSamples).toHaveLength(12)
  expect(benchmarkSamples.map((sample) => sample.id)).toEqual(
    FANOUT_DIRECTION_CASES.map((sample) => sample.id),
  )
  expect(new Set(benchmarkSamples.map((sample) => sample.dataset))).toEqual(
    new Set(["dataset31"]),
  )
  expect(
    new Set(benchmarkSamples.map((sample) => `${sample.dataset}/${sample.id}`))
      .size,
  ).toBe(benchmarkSamples.length)
  for (const dataset of [
    "31",
    "dataset31",
    "fanout31",
    "dataset-fanout31-am62l",
  ])
    expect(selectBenchmarkSamples({ dataset })).toEqual(benchmarkSamples)
  for (const dataset of [
    "dataset08",
    "srj19",
    "srj29",
    "all",
    "dataset31,srj29",
  ])
    expect(() => selectBenchmarkSamples({ dataset })).toThrow("Only dataset31")
  expect(selectBenchmarkSamples({ sample: "11-left-center" })).toEqual([
    benchmarkSamples[10],
  ])
  expect(
    selectBenchmarkSamples({ sample: "dataset31/11-left-center" }),
  ).toEqual([benchmarkSamples[10]])
  expect(selectBenchmarkSamples({ limit: 2 })).toHaveLength(2)
  expect(() => selectBenchmarkSamples({ sample: "missing" })).toThrow(
    "No benchmark samples",
  )
})
