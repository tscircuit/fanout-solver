import { expect, test } from "bun:test"
import {
  benchmarkSamples,
  selectBenchmarkSamples,
} from "../benchmarks/benchmark-catalog"
import {
  DATASET31_DIRECTION_CASES,
  FANOUT_DIRECTION_CASES,
  IMX6ULL_FANOUT_DIRECTION_CASES,
  K230_FANOUT_DIRECTION_CASES,
  RK3308_FANOUT_DIRECTION_CASES,
} from "../scripts/generate-repro/dataset31-source"

test("benchmark includes all four upstream dataset 31 families and rejects other datasets", () => {
  expect(benchmarkSamples).toHaveLength(48)
  expect(FANOUT_DIRECTION_CASES).toHaveLength(12)
  expect(RK3308_FANOUT_DIRECTION_CASES).toHaveLength(12)
  expect(K230_FANOUT_DIRECTION_CASES).toHaveLength(12)
  expect(IMX6ULL_FANOUT_DIRECTION_CASES).toHaveLength(12)
  expect(
    DATASET31_DIRECTION_CASES.filter((sample) => sample.chip === "am62l"),
  ).toHaveLength(12)
  expect(
    DATASET31_DIRECTION_CASES.filter((sample) => sample.chip === "rk3308"),
  ).toHaveLength(12)
  expect(
    DATASET31_DIRECTION_CASES.filter((sample) => sample.chip === "k230"),
  ).toHaveLength(12)
  expect(
    DATASET31_DIRECTION_CASES.filter((sample) => sample.chip === "imx6ull"),
  ).toHaveLength(12)
  expect(benchmarkSamples.map((sample) => sample.id)).toEqual(
    DATASET31_DIRECTION_CASES.map((sample) => sample.id),
  )
  expect(benchmarkSamples.slice(0, 12).map((sample) => sample.id)).toEqual(
    FANOUT_DIRECTION_CASES.map((sample) => sample.id),
  )
  expect(benchmarkSamples.slice(12, 24).map((sample) => sample.id)).toEqual(
    RK3308_FANOUT_DIRECTION_CASES.map((sample) => sample.id),
  )
  expect(benchmarkSamples.slice(24, 36).map((sample) => sample.id)).toEqual(
    K230_FANOUT_DIRECTION_CASES.map((sample) => sample.id),
  )
  expect(benchmarkSamples.slice(36).map((sample) => sample.id)).toEqual(
    IMX6ULL_FANOUT_DIRECTION_CASES.map((sample) => sample.id),
  )
  expect(benchmarkSamples[24]?.id).toBe("25-k230-top-left-offset")
  expect(benchmarkSamples[35]?.id).toBe("36-k230-left-top-offset")
  expect(benchmarkSamples[36]?.id).toBe("37-imx6ull-top-left-offset")
  expect(benchmarkSamples[47]?.id).toBe("48-imx6ull-left-top-offset")
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
  expect(selectBenchmarkSamples({ sample: "25-k230-top-left-offset" })).toEqual(
    [benchmarkSamples[24]],
  )
  expect(
    selectBenchmarkSamples({ sample: "dataset31/36-k230-left-top-offset" }),
  ).toEqual([benchmarkSamples[35]])
  expect(
    selectBenchmarkSamples({ sample: "37-imx6ull-top-left-offset" }),
  ).toEqual([benchmarkSamples[36]])
  expect(
    selectBenchmarkSamples({ sample: "dataset31/48-imx6ull-left-top-offset" }),
  ).toEqual([benchmarkSamples[47]])
  expect(selectBenchmarkSamples({ limit: 2 })).toHaveLength(2)
  expect(() => selectBenchmarkSamples({ sample: "missing" })).toThrow(
    "No benchmark samples",
  )
})
