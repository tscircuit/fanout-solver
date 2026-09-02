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
      dataset: "dataset01",
      sample: String(index),
      status,
      connections: 10,
      routed: status === "solved" ? 10 : 0,
      milliseconds: 1000,
    }),
  )
  const report = {
    version: 1,
    totalSamples: 5,
    configuration: { concurrency: 4, sampleTimeoutSeconds: 120 },
    rows,
  }
  const body = renderBenchmarkComment(report, options)
  expect(body).toContain("Solved 1/5")
  expect(body).toContain("Completed 4/5; partial 1; errors 1; timeouts 1")
  expect(body).toContain("Incomplete run")
  expect(body).toContain("dataset01 | 1/4 | 1 | 1 | 1")
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
    dataset: `dataset${index}`,
  }))
  expect(
    renderBenchmarkComment(
      { ...report, totalSamples: many.length, rows: many },
      options,
    ).length,
  ).toBeLessThan(60000)
  expect(renderBenchmarkComment(null, options)).toContain(
    "No readable benchmark report",
  )
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
