import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { FanoutSolver } from "lib/fanout-solver"
import { validateOriginalEndpointConnectivity } from "lib/validate-original-endpoint-connectivity"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import {
  SRJ29_FANOUT_LAYER_COUNT,
  type Srj29FanoutSample,
  srj29DatasetName,
  srj29FanoutSamples,
} from "../datasets/srj29"

interface BenchmarkOptions {
  sample?: string
  limit?: number
  maxLayerCombinations?: number
  concurrency: number
  sampleTimeoutSeconds?: number
  outputDirectory: string
  worker: boolean
  help: boolean
}

type BenchmarkStatus = "solved" | "partial" | "error" | "timeout"

interface BenchmarkRow {
  sample: string
  status: BenchmarkStatus
  bgaPads: number
  components: number
  obstacles: number
  connections: number
  routed: number
  completionPercent: number
  attempts: number
  vias: number | null
  validatedBreakouts: number | null
  connectedOriginalConnections: number | null
  connectionCompletionPercent: number | null
  disconnectedConnections: string[] | null
  routedCopperDrcValid: boolean | null
  routedCopperDrcIssueCount: number | null
  routedCopperDrcIssues: string[] | null
  milliseconds: number
  error?: string
}

interface BenchmarkReport {
  version: 3
  datasetName: string
  layerCount: number
  generatedAt: string
  configuration: {
    maxLayerCombinations: number
    concurrency: number
    sampleTimeoutSeconds: number | null
  }
  summary: {
    samples: number
    solved: number
    partial: number
    errors: number
    timeouts: number
    routedConnections: number
    connectedOriginalConnections: number
    drcCleanSamples: number
    totalConnections: number
    completionPercent: number
    connectionCompletionPercent: number
    solverMilliseconds: number
    wallClockMilliseconds: number
  }
  rows: BenchmarkRow[]
}

const DEFAULT_MAX_LAYER_COMBINATIONS = 256

function readPositiveInteger(flag: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

function parseOptions(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    concurrency: 1,
    outputDirectory: "benchmark-results",
    worker: false,
    help: false,
  }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    const [flag, inlineValue] = argument.split("=", 2)
    const readValue = () => inlineValue ?? args[++index]
    switch (flag) {
      case "--sample": {
        const value = readValue()
        if (!value) throw new Error("--sample requires a sample id")
        options.sample = value
        break
      }
      case "--limit":
        options.limit = readPositiveInteger(flag, readValue())
        break
      case "--max-layer-combinations":
        options.maxLayerCombinations = readPositiveInteger(flag, readValue())
        break
      case "--concurrency":
        options.concurrency = readPositiveInteger(flag, readValue())
        break
      case "--sample-timeout-seconds":
        options.sampleTimeoutSeconds = readPositiveInteger(flag, readValue())
        break
      case "--output-directory": {
        const value = readValue()
        if (!value) throw new Error("--output-directory requires a path")
        options.outputDirectory = value
        break
      }
      case "--worker":
        options.worker = true
        break
      case "--help":
      case "-h":
        options.help = true
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function printHelp(): void {
  console.log(`Usage: ./benchmark.sh [options]

Runs the six-layer SRJ29 fanout benchmark. Local runs process one sample at a
time by default; use --concurrency on a multi-core benchmark runner.

Options:
  --sample <sample001>             Run one sample
  --limit <count>                  Run the first count selected samples
  --max-layer-combinations <count> Maximum assignments per sample (default: 256)
  --concurrency <count>            Isolated sample processes to run in parallel
  --sample-timeout-seconds <count> Stop an individual sample after this duration
  --output-directory <path>        Report directory (default: benchmark-results)
  --help                           Show this help`)
}

function selectSamples(options: BenchmarkOptions): Srj29FanoutSample[] {
  let selectedSamples = srj29FanoutSamples
  if (options.sample) {
    selectedSamples = selectedSamples.filter(
      (sample) => sample.id === options.sample,
    )
    if (selectedSamples.length === 0) {
      throw new Error(`Unknown SRJ29 sample: ${options.sample}`)
    }
  }
  if (options.limit) selectedSamples = selectedSamples.slice(0, options.limit)
  return selectedSamples
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

function completionPercent(routed: number, connections: number): number {
  return connections === 0 ? 0 : round((routed / connections) * 100)
}

function createFailureRow(params: {
  sample: Srj29FanoutSample
  status: "error" | "timeout"
  milliseconds: number
  error: string
}): BenchmarkRow {
  const { sample, status, milliseconds, error } = params
  return {
    sample: sample.id,
    status,
    bgaPads: sample.bgaPadCount,
    components: sample.componentCount,
    obstacles: sample.obstacleCount,
    connections: sample.fanoutConnectionCount,
    routed: 0,
    completionPercent: 0,
    attempts: 0,
    vias: null,
    validatedBreakouts: null,
    connectedOriginalConnections: null,
    connectionCompletionPercent: null,
    disconnectedConnections: null,
    routedCopperDrcValid: null,
    routedCopperDrcIssueCount: null,
    routedCopperDrcIssues: null,
    milliseconds: round(milliseconds),
    error,
  }
}

function runSample(
  sample: Srj29FanoutSample,
  maxLayerCombinations: number,
): BenchmarkRow {
  const startTime = performance.now()
  try {
    const solver = new FanoutSolver(sample.simpleRouteJson, {
      ...sample.solverOptions,
      maxLayerCombinations,
    })
    solver.solve()
    const elapsedMilliseconds = performance.now() - startTime
    const bestAttempt = solver.attempts.toSorted(
      (first, second) => first.score - second.score,
    )[0]
    const routedConnections = bestAttempt?.routedConnectionCount ?? 0
    const output = solver.solved ? solver.getOutput() : null
    const endpointConnectivity = output
      ? validateOriginalEndpointConnectivity({
          inputSrj: sample.simpleRouteJson,
          routedSrj: output.simpleRouteJson,
        })
      : null
    const routedCopperDrc = output
      ? validateRoutedCopperDrc({
          inputSrj: sample.simpleRouteJson,
          routedSrj: output.simpleRouteJson,
          clearance: solver.config.clearance,
        })
      : null
    const solutionIsValidated =
      output?.validation.valid === true &&
      output.validation.checkedConnectionCount ===
        sample.fanoutConnectionCount &&
      output.validation.brokenOutConnectionCount ===
        sample.fanoutConnectionCount &&
      endpointConnectivity?.valid === true &&
      endpointConnectivity.checkedConnectionCount ===
        sample.fanoutConnectionCount &&
      endpointConnectivity.connectedConnectionCount ===
        sample.fanoutConnectionCount &&
      routedCopperDrc?.valid === true
    const viaCount = output
      ? output.fanoutTraces.filter((trace) =>
          trace.route.some((point) => point.route_type === "via"),
        ).length
      : null

    return {
      sample: sample.id,
      status: solutionIsValidated ? "solved" : "partial",
      bgaPads: sample.bgaPadCount,
      components: sample.componentCount,
      obstacles: sample.obstacleCount,
      connections: sample.fanoutConnectionCount,
      routed: routedConnections,
      completionPercent: completionPercent(
        routedConnections,
        sample.fanoutConnectionCount,
      ),
      attempts: solver.attempts.length,
      vias: viaCount,
      validatedBreakouts: output?.validation.brokenOutConnectionCount ?? null,
      connectedOriginalConnections:
        endpointConnectivity?.connectedConnectionCount ?? null,
      connectionCompletionPercent: endpointConnectivity
        ? completionPercent(
            endpointConnectivity.connectedConnectionCount,
            sample.fanoutConnectionCount,
          )
        : null,
      disconnectedConnections:
        endpointConnectivity?.issues.map((issue) => issue.connectionName) ??
        null,
      routedCopperDrcValid: routedCopperDrc?.valid ?? null,
      routedCopperDrcIssueCount: routedCopperDrc?.issues.length ?? null,
      routedCopperDrcIssues:
        routedCopperDrc?.issues.map((issue) => issue.message) ?? null,
      milliseconds: round(elapsedMilliseconds),
    }
  } catch (error) {
    return createFailureRow({
      sample,
      status: "error",
      milliseconds: performance.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runSampleProcess(params: {
  sample: Srj29FanoutSample
  maxLayerCombinations: number
  sampleTimeoutSeconds?: number
}): Promise<BenchmarkRow> {
  const { sample, maxLayerCombinations, sampleTimeoutSeconds } = params
  const startTime = performance.now()
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      import.meta.path,
      "--worker",
      "--sample",
      sample.id,
      "--max-layer-combinations",
      String(maxLayerCombinations),
    ],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timeout = sampleTimeoutSeconds
    ? setTimeout(() => {
        timedOut = true
        child.kill()
      }, sampleTimeoutSeconds * 1_000)
    : undefined
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  const exitCode = await child.exited
  if (timeout) clearTimeout(timeout)
  const stdout = await stdoutPromise
  const stderr = await stderrPromise
  const elapsedMilliseconds = performance.now() - startTime

  if (timedOut) {
    return createFailureRow({
      sample,
      status: "timeout",
      milliseconds: elapsedMilliseconds,
      error: `Exceeded ${sampleTimeoutSeconds} seconds`,
    })
  }
  if (exitCode !== 0) {
    return createFailureRow({
      sample,
      status: "error",
      milliseconds: elapsedMilliseconds,
      error: stderr.trim() || `Worker exited with code ${exitCode}`,
    })
  }
  try {
    return JSON.parse(stdout) as BenchmarkRow
  } catch (error) {
    return createFailureRow({
      sample,
      status: "error",
      milliseconds: elapsedMilliseconds,
      error: `Could not parse worker result: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

function printProgress(
  row: BenchmarkRow,
  completed: number,
  total: number,
): void {
  const duration = `${(row.milliseconds / 1_000).toFixed(2)}s`
  const attempts = `${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`
  console.log(
    `[${String(completed).padStart(String(total).length)}/${total}] ${row.sample} ${row.status}: fanout ${row.routed}/${row.connections} (${row.completionPercent.toFixed(1)}%), connected ${row.connectedOriginalConnections ?? 0}/${row.connections} (${(row.connectionCompletionPercent ?? 0).toFixed(1)}%), ${attempts}, ${duration}`,
  )
  if (row.error) console.log(`  ${row.error}`)
}

async function runSamples(params: {
  samples: Srj29FanoutSample[]
  concurrency: number
  maxLayerCombinations: number
  sampleTimeoutSeconds?: number
}): Promise<BenchmarkRow[]> {
  const { samples, concurrency, maxLayerCombinations, sampleTimeoutSeconds } =
    params
  const rows = new Array<BenchmarkRow>(samples.length)
  let nextIndex = 0
  let completed = 0
  const workerCount = Math.min(concurrency, samples.length)

  const runNext = async (): Promise<void> => {
    while (nextIndex < samples.length) {
      const sampleIndex = nextIndex++
      const sample = samples[sampleIndex]!
      const row = await runSampleProcess({
        sample,
        maxLayerCombinations,
        sampleTimeoutSeconds,
      })
      rows[sampleIndex] = row
      completed++
      printProgress(row, completed, samples.length)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runNext()))
  return rows
}

function buildReport(params: {
  rows: BenchmarkRow[]
  maxLayerCombinations: number
  concurrency: number
  sampleTimeoutSeconds?: number
  wallClockMilliseconds: number
}): BenchmarkReport {
  const {
    rows,
    maxLayerCombinations,
    concurrency,
    sampleTimeoutSeconds,
    wallClockMilliseconds,
  } = params
  const routedConnections = rows.reduce((sum, row) => sum + row.routed, 0)
  const connectedOriginalConnections = rows.reduce(
    (sum, row) => sum + (row.connectedOriginalConnections ?? 0),
    0,
  )
  const totalConnections = rows.reduce((sum, row) => sum + row.connections, 0)
  return {
    version: 3,
    datasetName: srj29DatasetName,
    layerCount: SRJ29_FANOUT_LAYER_COUNT,
    generatedAt: new Date().toISOString(),
    configuration: {
      maxLayerCombinations,
      concurrency,
      sampleTimeoutSeconds: sampleTimeoutSeconds ?? null,
    },
    summary: {
      samples: rows.length,
      solved: rows.filter((row) => row.status === "solved").length,
      partial: rows.filter((row) => row.status === "partial").length,
      errors: rows.filter((row) => row.status === "error").length,
      timeouts: rows.filter((row) => row.status === "timeout").length,
      routedConnections,
      connectedOriginalConnections,
      drcCleanSamples: rows.filter((row) => row.routedCopperDrcValid === true)
        .length,
      totalConnections,
      completionPercent: completionPercent(routedConnections, totalConnections),
      connectionCompletionPercent: completionPercent(
        connectedOriginalConnections,
        totalConnections,
      ),
      solverMilliseconds: round(
        rows.reduce((sum, row) => sum + row.milliseconds, 0),
      ),
      wallClockMilliseconds: round(wallClockMilliseconds),
    },
    rows,
  }
}

function renderMarkdown(report: BenchmarkReport): string {
  const { configuration, summary } = report
  const lines = [
    "# SRJ29 Fanout Benchmark",
    "",
    `- Layers: ${report.layerCount}`,
    `- Solved: ${summary.solved}/${summary.samples}`,
    `- Fanout prefixes: ${summary.routedConnections}/${summary.totalConnections} (${summary.completionPercent.toFixed(1)}%)`,
    `- Original connections physically connected in complete fanout attempts: ${summary.connectedOriginalConnections}/${summary.totalConnections} (${summary.connectionCompletionPercent.toFixed(1)}%)`,
    `- Complete fanout attempts with independently clean emitted copper: ${summary.drcCleanSamples}/${summary.samples}`,
    `- Partial/errors/timeouts: ${summary.partial}/${summary.errors}/${summary.timeouts}`,
    `- Assignment budget: ${configuration.maxLayerCombinations} per sample`,
    `- Concurrency: ${configuration.concurrency}`,
    `- Wall time: ${(summary.wallClockMilliseconds / 1_000).toFixed(2)}s`,
    `- Aggregate solver time: ${(summary.solverMilliseconds / 1_000).toFixed(2)}s`,
    "",
    "| Sample | Status | Fanout prefixes | Validated breakouts | Original connections connected | Emitted-copper DRC | Attempts | Vias | Time |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]
  for (const row of report.rows) {
    lines.push(
      `| ${row.sample} | ${row.status} | ${row.routed}/${row.connections} (${row.completionPercent.toFixed(1)}%) | ${row.validatedBreakouts === null ? "-" : `${row.validatedBreakouts}/${row.connections}`} | ${row.connectedOriginalConnections === null ? "-" : `${row.connectedOriginalConnections}/${row.connections} (${(row.connectionCompletionPercent ?? 0).toFixed(1)}%)`} | ${row.routedCopperDrcValid === null ? "-" : row.routedCopperDrcValid ? "clean" : `${row.routedCopperDrcIssueCount} issue(s)`} | ${row.attempts} | ${row.vias ?? "-"} | ${(row.milliseconds / 1_000).toFixed(2)}s |`,
    )
  }
  return `${lines.join("\n")}\n`
}

function renderConsoleSummary(report: BenchmarkReport): string {
  const { configuration, summary } = report
  return [
    `Solved: ${summary.solved}/${summary.samples}`,
    `Fanout prefixes: ${summary.routedConnections}/${summary.totalConnections} (${summary.completionPercent.toFixed(1)}%)`,
    `Original connections connected: ${summary.connectedOriginalConnections}/${summary.totalConnections} (${summary.connectionCompletionPercent.toFixed(1)}%)`,
    `Independently DRC-clean complete attempts: ${summary.drcCleanSamples}/${summary.samples}`,
    `Partial/errors/timeouts: ${summary.partial}/${summary.errors}/${summary.timeouts}`,
    `Layers/assignment budget/concurrency: ${report.layerCount}/${configuration.maxLayerCombinations}/${configuration.concurrency}`,
    `Wall time/aggregate solver time: ${(summary.wallClockMilliseconds / 1_000).toFixed(2)}s/${(summary.solverMilliseconds / 1_000).toFixed(2)}s`,
  ].join("\n")
}

async function writeReport(
  report: BenchmarkReport,
  outputDirectory: string,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    Bun.write(
      join(outputDirectory, "srj29.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    ),
    Bun.write(join(outputDirectory, "srj29.md"), renderMarkdown(report)),
  ])
}

const options = parseOptions(Bun.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const selectedSamples = selectSamples(options)
const maxLayerCombinations =
  options.maxLayerCombinations ??
  selectedSamples[0]?.solverOptions.maxLayerCombinations ??
  DEFAULT_MAX_LAYER_COMBINATIONS

if (options.worker) {
  if (selectedSamples.length !== 1) {
    throw new Error("An SRJ29 benchmark worker requires exactly one sample")
  }
  console.log(
    JSON.stringify(runSample(selectedSamples[0]!, maxLayerCombinations)),
  )
  process.exit(0)
}

console.log(
  `Running ${selectedSamples.length} SRJ29 sample${selectedSamples.length === 1 ? "" : "s"} with ${SRJ29_FANOUT_LAYER_COUNT} layers, ${maxLayerCombinations} assignments, and concurrency ${Math.min(options.concurrency, selectedSamples.length)}`,
)
const startTime = performance.now()
const rows = await runSamples({
  samples: selectedSamples,
  concurrency: options.concurrency,
  maxLayerCombinations,
  sampleTimeoutSeconds: options.sampleTimeoutSeconds,
})
const report = buildReport({
  rows,
  maxLayerCombinations,
  concurrency: Math.min(options.concurrency, selectedSamples.length),
  sampleTimeoutSeconds: options.sampleTimeoutSeconds,
  wallClockMilliseconds: performance.now() - startTime,
})
await writeReport(report, options.outputDirectory)
console.log("")
console.log(renderConsoleSummary(report))
console.log(
  `Reports: ${join(options.outputDirectory, "srj29.json")}, ${join(options.outputDirectory, "srj29.md")}`,
)
