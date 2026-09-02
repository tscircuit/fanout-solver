import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { getSvgFromGraphicsObject } from "graphics-debug"
import {
  createAm62lRamLeftInput,
  createAm62lRamLeftSubset,
} from "../datasets/dataset08"
import { FanoutSolver } from "../lib/fanout-solver"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "timeout-ms": { type: "string", default: "60000" },
    buses: { type: "string" },
    "connection-limit": { type: "string" },
    "max-layer-combinations": { type: "string" },
    "no-length-matching": { type: "boolean", default: false },
    output: { type: "string" },
    worker: { type: "boolean", default: false },
  },
})
const timeoutMs = Number(values["timeout-ms"])
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("--timeout-ms must be a positive number")
}

// A single solver step may run synchronous fallback searches. Use a separate
// process so the diagnostic timeout still applies while that step is running.
if (!values.worker) {
  const startedAt = performance.now()
  let hardTimedOut = false
  const child = Bun.spawn(
    [process.execPath, import.meta.path, ...process.argv.slice(2), "--worker"],
    { stdout: "inherit", stderr: "inherit" },
  )
  const timeout = setTimeout(() => {
    hardTimedOut = true
    console.error(`Hard timeout after ${timeoutMs} ms.`)
    child.kill("SIGKILL")
  }, timeoutMs + 1_000)
  const exitCode = await child.exited
  clearTimeout(timeout)
  if (hardTimedOut && values.output) {
    const reportPath = `${values.output}.json`
    const lastProgress = existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, "utf8"))
      : {}
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          ...lastProgress,
          inProgress: false,
          timedOut: true,
          hardTimeout: true,
          lastProgressElapsedMs: lastProgress.elapsedMs,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
        null,
        2,
      )}\n`,
    )
    console.error(`Saved timeout status to ${reportPath}.`)
  }
  process.exit(exitCode)
}

const { simpleRouteJson, solverOptions } =
  values.buses || values["connection-limit"]
    ? createAm62lRamLeftSubset({
        busIds: values.buses?.split(","),
        connectionLimit: values["connection-limit"]
          ? Number(values["connection-limit"])
          : undefined,
      })
    : createAm62lRamLeftInput()
if (values["max-layer-combinations"]) {
  const maximum = Number(values["max-layer-combinations"])
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new Error("--max-layer-combinations must be a positive integer")
  }
  solverOptions.maxLayerCombinations = maximum
}
if (values["no-length-matching"]) {
  simpleRouteJson.differentialPairs = []
  solverOptions.buses = solverOptions.buses?.map((bus) => ({
    ...bus,
    maxLengthSkew: undefined,
  }))
  simpleRouteJson.buses = simpleRouteJson.buses?.map((bus) => ({
    ...bus,
    maxLengthSkew: undefined,
  }))
}

console.log({
  sample: "11-left-center",
  connections: simpleRouteJson.connections.length,
  buses: solverOptions.buses?.length,
  obstacles: simpleRouteJson.obstacles.length,
  lengthMatching: !values["no-length-matching"],
  maxLayerCombinations: solverOptions.maxLayerCombinations ?? "default",
  timeoutMs,
})
const solver = new FanoutSolver(simpleRouteJson, solverOptions)
const startedAt = performance.now()
const writeArtifacts = (report: Record<string, unknown>) => {
  if (!values.output) return
  writeFileSync(`${values.output}.json`, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(
    `${values.output}.svg`,
    getSvgFromGraphicsObject(solver.visualize()),
  )
}
const getProgressReport = () => ({
  solved: solver.solved,
  failed: solver.failed,
  inProgress: !solver.solved && !solver.failed,
  timedOut: false,
  elapsedMs: Math.round(performance.now() - startedAt),
  stats: solver.stats,
  activeStats: solver.activeSubSolver?.stats,
  attempts: solver.attempts,
})
writeArtifacts(getProgressReport())
let nextProgressAt = startedAt + 5_000
while (!solver.solved && !solver.failed) {
  if (performance.now() - startedAt >= timeoutMs) break
  solver.step()
  if (performance.now() >= nextProgressAt) {
    console.log({
      elapsedMs: Math.round(performance.now() - startedAt),
      stats: solver.stats,
      activeStats: solver.activeSubSolver?.stats,
    })
    writeArtifacts(getProgressReport())
    nextProgressAt = performance.now() + 5_000
  }
}
const output = solver.solved ? solver.getOutput() : undefined
const report = {
  solved: solver.solved,
  failed: solver.failed,
  inProgress: false,
  timedOut: !solver.solved && !solver.failed,
  error: solver.error,
  elapsedMs: Math.round(performance.now() - startedAt),
  iterations: solver.iterations,
  stats: solver.stats,
  activeStats: solver.activeSubSolver?.stats,
  attempts: solver.attempts,
  validation: output?.validation,
}
console.log(JSON.stringify(report, null, 2))
writeArtifacts(report)
if (values.output) {
  console.log(`Saved ${values.output}.{json,svg}`)
}
process.exitCode = solver.solved ? 0 : 1
