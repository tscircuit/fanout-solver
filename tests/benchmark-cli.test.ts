import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BenchmarkReport } from "../benchmarks/benchmark-types"

test("benchmark shell entrypoint writes complete ordered JSON and Markdown reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fanout-benchmark-test-"))
  try {
    const child = Bun.spawn(
      [
        "bash",
        "./benchmark.sh",
        "--dataset",
        "dataset01",
        "--limit",
        "2",
        "--concurrency",
        "2",
        "--output-directory",
        directory,
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" },
    )
    const stderr = new Response(child.stderr).text()
    expect(await child.exited, await stderr).toBe(0)
    const report: BenchmarkReport = JSON.parse(
      await readFile(join(directory, "benchmark.json"), "utf8"),
    )
    expect(report.totalSamples).toBe(2)
    expect(report.rows.map((row) => [row.sample, row.status])).toEqual([
      ["sample001", "solved"],
      ["sample002", "solved"],
    ])
    expect(report.configuration.maxLayerCombinations).toBeUndefined()
    expect(report.configuration.sampleTimeoutSeconds).toBe(120)
    expect(await readFile(join(directory, "benchmark.md"), "utf8")).toContain(
      "Solved 2/2 selected samples",
    )
    const invalid = Bun.spawn(
      ["bash", "./benchmark.sh", "--concurrency", "0"],
      { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "ignore" },
    )
    expect(await invalid.exited).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
