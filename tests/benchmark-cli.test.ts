import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BenchmarkReport } from "../benchmarks/benchmark-types"

test("benchmark shell entrypoint writes complete ordered JSON and Markdown reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fanout-benchmark-test-"))
  try {
    await writeFile(join(directory, "01-top-left-offset.svg"), "stale")
    await writeFile(join(directory, "02-top-center.svg"), "stale")
    await writeFile(join(directory, "11-left-center.svg"), "unselected")
    const child = Bun.spawn(
      [
        "bash",
        "./benchmark.sh",
        "--limit",
        "2",
        "--concurrency",
        "2",
        "--sample-timeout-seconds",
        "1",
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
    expect(report.version).toBe(2)
    expect(report.dataset).toBe("dataset31")
    expect(report.datasetSource.repository).toBe(
      "https://github.com/tscircuit/dataset-fanout31-am62l",
    )
    expect(report.rows.map((row) => row.sample)).toEqual([
      "01-top-left-offset",
      "02-top-center",
    ])
    for (const row of report.rows) {
      expect(row.dataset).toBe("dataset31")
      expect(row.connections).toBe(135)
      expect(["solved", "partial", "timeout"]).toContain(row.status)
      expect(
        await Bun.file(
          join(directory, "inputs", `${row.sample}.json`),
        ).exists(),
      ).toBe(true)
      const snapshot = Bun.file(join(directory, `${row.sample}.svg`))
      expect(await snapshot.exists()).toBe(row.status === "solved")
      if (row.status === "solved")
        expect(await snapshot.text()).toContain("<svg")
      expect(row).not.toHaveProperty("svg")
    }
    expect(await readFile(join(directory, "11-left-center.svg"), "utf8")).toBe(
      "unselected",
    )
    expect(report.configuration.maxLayerCombinations).toBeUndefined()
    expect(report.configuration.sampleTimeoutSeconds).toBe(1)
    const markdown = await readFile(join(directory, "benchmark.md"), "utf8")
    expect(markdown).toContain(
      "Dataset 31 — AM62L, RK3308, K230, and i.MX6ULL fanout benchmark",
    )
    expect(markdown).toContain("Completed 2/2")
    expect(markdown).toContain(
      "135 for AM62L; 162 for RK3308; 171 for K230; 102 for i.MX6ULL",
    )
    expect(markdown).not.toMatch(/SRJ19|SRJ29|dataset0[1-8]/)
    for (const [sampleId, connections] of [
      ["13-rk3308-top-left-offset", 162],
      ["25-k230-top-left-offset", 171],
      ["37-imx6ull-top-left-offset", 102],
    ] as const) {
      const single = Bun.spawn(
        [
          "bash",
          "./benchmark.sh",
          "--sample",
          sampleId,
          "--sample-timeout-seconds",
          "1",
          "--output-directory",
          directory,
        ],
        { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" },
      )
      const stderr = new Response(single.stderr).text()
      expect(await single.exited, await stderr).toBe(0)
      const singleReport: BenchmarkReport = JSON.parse(
        await readFile(join(directory, "benchmark.json"), "utf8"),
      )
      expect(singleReport.totalSamples).toBe(1)
      expect(singleReport.rows).toHaveLength(1)
      expect(singleReport.rows[0]).toMatchObject({
        dataset: "dataset31",
        sample: sampleId,
        connections,
      })
      expect(["solved", "partial", "timeout"]).toContain(
        singleReport.rows[0]!.status,
      )
      expect(await Bun.file(join(directory, `${sampleId}.svg`)).exists()).toBe(
        singleReport.rows[0]!.status === "solved",
      )
    }
    for (const args of [
      ["--concurrency", "0"],
      ["--dataset", "srj29"],
    ]) {
      const invalid = Bun.spawn(["bash", "./benchmark.sh", ...args], {
        cwd: join(import.meta.dir, ".."),
        stdout: "ignore",
        stderr: "ignore",
      })
      expect(await invalid.exited).not.toBe(0)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
