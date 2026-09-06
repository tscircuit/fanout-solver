import { expect, test } from "bun:test"
import {
  benchmarkSamples,
  selectBenchmarkSamples,
} from "../benchmarks/benchmark-catalog"
import {
  DATASET31_DIRECTION_CASES,
  FANOUT_DIRECTION_CASES,
  RK3308_FANOUT_DIRECTION_CASES,
} from "../scripts/generate-repro/dataset31-source"

test("benchmark includes both upstream dataset 31 families and rejects other datasets", () => {
  expect(benchmarkSamples).toHaveLength(24)
  expect(FANOUT_DIRECTION_CASES).toHaveLength(12)
  expect(RK3308_FANOUT_DIRECTION_CASES).toHaveLength(12)
  expect(
    DATASET31_DIRECTION_CASES.filter((sample) => sample.chip === "am62l"),
  ).toHaveLength(12)
  expect(
    DATASET31_DIRECTION_CASES.filter((sample) => sample.chip === "rk3308"),
  ).toHaveLength(12)
  expect(benchmarkSamples.map((sample) => sample.id)).toEqual(
    DATASET31_DIRECTION_CASES.map((sample) => sample.id),
  )
  expect(benchmarkSamples.slice(0, 12).map((sample) => sample.id)).toEqual(
    FANOUT_DIRECTION_CASES.map((sample) => sample.id),
  )
  expect(benchmarkSamples.slice(12).map((sample) => sample.id)).toEqual(
    RK3308_FANOUT_DIRECTION_CASES.map((sample) => sample.id),
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
  expect(
    selectBenchmarkSamples({ sample: "13-rk3308-top-left-offset" }),
  ).toEqual([benchmarkSamples[12]])
  expect(
    selectBenchmarkSamples({ sample: "dataset31/24-rk3308-left-top-offset" }),
  ).toEqual([benchmarkSamples[23]])
  expect(selectBenchmarkSamples({ limit: 2 })).toHaveLength(2)
  expect(() => selectBenchmarkSamples({ sample: "missing" })).toThrow(
    "No benchmark samples",
  )
})
