import { expect, test } from "bun:test"
import { renderBenchmarkComment } from "../benchmarks/pr-benchmark.js"

test("PR benchmark comments count failures, flag incomplete runs, and bound untrusted report data", () => {
  const options = {
    ref: "a".repeat(40),
    runUrl: "https://github.com/tscircuit/fanout-solver/actions/runs/1",
    result: "success",
  }
  const rows = ["solved", "partial", "error", "timeout"].map(
    (status, index) => ({
      dataset: "dataset31",
      sample: String(index),
      status,
      connections: 10,
      routed: status === "solved" ? 10 : 0,
      milliseconds: 1000,
    }),
  )
  const report = {
    version: 2,
    dataset: "dataset31",
    datasetSource: { commit: "b".repeat(40) },
    totalSamples: 5,
    configuration: { concurrency: 4, sampleTimeoutSeconds: 120 },
    rows,
  }
  const body = renderBenchmarkComment(report, options)
  expect(body).toContain("Solved 1/5")
  expect(body).toContain("Completed 4/5; partial 1; errors 1; timeouts 1")
  expect(body).toContain("Incomplete run")
  expect(body).toContain(
    "Dataset 31 — AM62L, RK3308, K230, and i.MX6ULL fanout benchmark",
  )
  expect(body).toContain("Dataset revision: `bbbbbbb`")
  expect(body).toContain(
    "135 for AM62L; 162 for RK3308; 171 for K230; 102 for i.MX6ULL",
  )
  const mixedFamilyReport = {
    ...report,
    totalSamples: 48,
    rows: [
      {
        ...rows[0],
        sample: "01-top-left-offset",
        connections: 135,
        routed: 135,
      },
      {
        ...rows[0],
        sample: "13-rk3308-top-left-offset",
        connections: 162,
        routed: 162,
      },
      {
        ...rows[0],
        sample: "25-k230-top-left-offset",
        connections: 171,
        routed: 171,
      },
      {
        ...rows[0],
        sample: "37-imx6ull-top-left-offset",
        connections: 102,
        routed: 102,
      },
    ],
  }
  const mixedFamilyBody = renderBenchmarkComment(mixedFamilyReport, options)
  expect(mixedFamilyBody).toContain("Solved 4/48 selected samples")
  expect(mixedFamilyBody).toContain("Completed 4/48")
  expect(mixedFamilyBody).toContain("01-top-left-offset | solved | 135/135")
  expect(mixedFamilyBody).toContain(
    "13-rk3308-top-left-offset | solved | 162/162",
  )
  expect(mixedFamilyBody).toContain(
    "25-k230-top-left-offset | solved | 171/171",
  )
  expect(mixedFamilyBody).toContain(
    "37-imx6ull-top-left-offset | solved | 102/102",
  )
  expect(body).not.toMatch(/SRJ19|SRJ29|dataset0[1-8]/)
  const malicious = {
    ...report,
    rows: [{ ...rows[0], sample: "@everyone|<script>" }],
  }
  const safe = renderBenchmarkComment(malicious, options)
  expect(safe).not.toContain("@everyone")
  expect(safe).not.toContain("<script>")
  expect(safe).toContain("&#124;")
  const many = Array.from({ length: 1000 }, (_, index) => ({
    ...rows[0],
    sample: `${index}-${"x".repeat(150)}`,
  }))
  expect(
    renderBenchmarkComment(
      { ...report, totalSamples: many.length, rows: many },
      options,
    ).length,
  ).toBeLessThan(60000)
  expect(renderBenchmarkComment(null, options)).toContain(
    "No readable dataset 31 benchmark report",
  )
  expect(() =>
    renderBenchmarkComment({ ...report, version: 1 }, options),
  ).toThrow("Invalid benchmark report")
  expect(() =>
    renderBenchmarkComment({ ...report, dataset: "all" }, options),
  ).toThrow("Invalid benchmark report")
  expect(() =>
    renderBenchmarkComment(
      { ...report, rows: [...rows, { ...rows[0], dataset: "srj29" }] },
      options,
    ),
  ).toThrow("Invalid benchmark row")
  expect(() =>
    renderBenchmarkComment({ ...report, rows: [rows[0], rows[0]] }, options),
  ).toThrow("Duplicate")
  expect(() =>
    renderBenchmarkComment(
      { ...report, rows: [{ ...rows[0], milliseconds: Infinity }] },
      options,
    ),
  ).toThrow("Invalid")
})
