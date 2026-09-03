import { fileURLToPath } from "node:url"
import type {
  BenchmarkConfiguration,
  BenchmarkRow,
  BenchmarkSample,
} from "./benchmark-types"

/** A process deadline also interrupts a solver stuck inside one synchronous step. */
export async function runSampleProcess(
  sample: BenchmarkSample,
  configuration: BenchmarkConfiguration,
  workerPath = fileURLToPath(new URL("./benchmark-worker.ts", import.meta.url)),
): Promise<BenchmarkRow> {
  const startedAt = performance.now()
  const failure = (
    status: "error" | "timeout",
    error: string,
  ): BenchmarkRow => ({
    dataset: sample.dataset,
    sample: sample.id,
    status,
    scope: "fanout",
    connections: sample.simpleRouteJson.connections.length,
    routed: 0,
    validatedBreakouts: null,
    attempts: 0,
    vias: null,
    milliseconds: Math.round(performance.now() - startedAt),
    error,
  })
  let timedOut = false
  try {
    const child = Bun.spawn([process.execPath, workerPath], {
      stdin: new Blob([
        JSON.stringify({
          sample,
          maxLayerCombinations: configuration.maxLayerCombinations,
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, configuration.sampleTimeoutSeconds * 1000)
    const stdoutPromise = new Response(child.stdout).text()
    const stderrPromise = new Response(child.stderr).text()
    const exitCode = await child.exited
    clearTimeout(timeout)
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (timedOut)
      return failure(
        "timeout",
        `Exceeded ${configuration.sampleTimeoutSeconds}s process deadline`,
      )
    if (exitCode !== 0)
      return failure(
        "error",
        stderr.trim().slice(-2000) || `Worker exited with code ${exitCode}`,
      )
    const row = JSON.parse(stdout.trim().split("\n").at(-1)!) as BenchmarkRow
    if (
      row.dataset !== sample.dataset ||
      row.sample !== sample.id ||
      !["solved", "partial", "error"].includes(row.status)
    )
      throw new Error("Invalid worker result")
    return row
  } catch (error) {
    return failure(
      "error",
      error instanceof Error ? error.message : String(error),
    )
  }
}
