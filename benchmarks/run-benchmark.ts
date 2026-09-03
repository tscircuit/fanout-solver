import { mkdir, rename, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { dataset31Source } from "../scripts/generate-repro/dataset31-source"
import { selectBenchmarkSamples } from "./benchmark-catalog"
import type {
  BenchmarkConfiguration,
  BenchmarkReport,
  BenchmarkRow,
} from "./benchmark-types"
import { prepareDataset31Samples } from "./prepare-dataset31"
import { renderBenchmarkMarkdown } from "./render-benchmark-markdown"
import { runSampleProcess } from "./run-sample-process"

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: "string" },
      sample: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      "sample-timeout-seconds": { type: "string" },
      "max-layer-combinations": { type: "string" },
      "output-directory": { type: "string", default: "benchmark-results" },
      list: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (values.help) {
    console.log(`Usage: ./benchmark.sh [options]

Runs only dataset-fanout31-am62l: all 12 directional AM62L fanout cases.
Captures the upstream TSX/core inputs, then benchmarks this checkout's solver.
Failures and timeouts are results, not fatal errors.

  --dataset <dataset31>            Optional; no other datasets are supported
  --sample <id or dataset/id>      Filter samples
  --limit <count>                  Limit the selected samples
  --concurrency <count>            Parallel processes (default: up to 4)
  --sample-timeout-seconds <count>  Hard per-process deadline (default: 120)
  --max-layer-combinations <count> Override sample assignment budgets
  --output-directory <path>        JSON/Markdown directory (default: benchmark-results)
  --list                          List selected samples without solving
  --help                          Show help`)
    return
  }
  const positive = (
    flag: string,
    value: string | undefined,
    fallback?: number,
  ) => {
    if (value === undefined) return fallback
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error(`${flag} must be a positive integer`)
    return number
  }
  const configuration: BenchmarkConfiguration = {
    concurrency: positive(
      "--concurrency",
      values.concurrency,
      Math.min(4, availableParallelism()),
    )!,
    sampleTimeoutSeconds: positive(
      "--sample-timeout-seconds",
      values["sample-timeout-seconds"],
      120,
    )!,
    maxLayerCombinations: positive(
      "--max-layer-combinations",
      values["max-layer-combinations"],
    ),
  }
  const definitions = selectBenchmarkSamples({
    dataset: values.dataset,
    sample: values.sample,
    limit: positive("--limit", values.limit),
  })
  if (values.list) {
    for (const sample of definitions)
      console.log(`${sample.dataset}/${sample.id}`)
    console.log(`${definitions.length} dataset 31 samples`)
    return
  }
  const outputDirectory = values["output-directory"]!
  console.log(
    `Capturing ${definitions.length} dataset 31 inputs from upstream TSX (${dataset31Source.commit.slice(0, 7)})`,
  )
  const samples = await prepareDataset31Samples(
    definitions.map((sample) => sample.id),
    join(outputDirectory, "inputs"),
  )
  const startedAt = performance.now()
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const commit =
    revision.exitCode === 0 ? revision.stdout.toString().trim() : null
  const results = new Map<number, BenchmarkRow>()
  await mkdir(outputDirectory, { recursive: true })
  // Ordered partial reports survive a later sample crash or whole-job timeout.
  let writes = Promise.resolve()
  const save = () => {
    const report: BenchmarkReport = {
      version: 2,
      dataset: "dataset31",
      datasetSource: dataset31Source,
      generatedAt: new Date().toISOString(),
      commit,
      configuration,
      wallClockMilliseconds: Math.round(performance.now() - startedAt),
      totalSamples: samples.length,
      rows: [...results.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, row]) => row),
    }
    writes = writes.then(async () => {
      await writeFile(
        join(outputDirectory, "benchmark.json.tmp"),
        `${JSON.stringify(report, null, 2)}\n`,
      )
      await rename(
        join(outputDirectory, "benchmark.json.tmp"),
        join(outputDirectory, "benchmark.json"),
      )
      await writeFile(
        join(outputDirectory, "benchmark.md.tmp"),
        renderBenchmarkMarkdown(report),
      )
      await rename(
        join(outputDirectory, "benchmark.md.tmp"),
        join(outputDirectory, "benchmark.md"),
      )
    })
    return writes
  }
  await save()
  console.log(
    `Running ${samples.length} dataset 31 samples; concurrency ${configuration.concurrency}; deadline ${configuration.sampleTimeoutSeconds}s; assignment budget ${configuration.maxLayerCombinations ?? "sample defaults"}`,
  )
  let nextIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(configuration.concurrency, samples.length) },
      async () => {
        while (nextIndex < samples.length) {
          const index = nextIndex++
          const sample = samples[index]!
          const row = await runSampleProcess(sample, configuration)
          results.set(index, row)
          console.log(
            `[${results.size}/${samples.length}] ${sample.dataset}/${sample.id}: ${row.status}, ${row.routed}/${row.connections}, ${(row.milliseconds / 1000).toFixed(2)}s`,
          )
          if (row.error)
            console.log(`  ${row.error.replaceAll("\n", " ").slice(0, 300)}`)
          await save()
        }
      },
    ),
  )
  const rows = [...results.values()]
  console.log(
    `Solved ${rows.filter((row) => row.status === "solved").length}/${samples.length}; partial ${rows.filter((row) => row.status === "partial").length}; errors ${rows.filter((row) => row.status === "error").length}; timeouts ${rows.filter((row) => row.status === "timeout").length}`,
  )
  console.log(
    `Reports: ${join(outputDirectory, "benchmark.json")} and ${join(outputDirectory, "benchmark.md")}`,
  )
}

if (import.meta.main) await main()
