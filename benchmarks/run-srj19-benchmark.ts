import { FanoutSolver } from "lib/fanout-solver"
import { srj19FanoutSamples } from "../datasets/srj19"

interface BenchmarkOptions {
  sample?: string
  limit?: number
  maxLayerCombinations?: number
}

function readPositiveInteger(flag: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

function parseOptions(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {}
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    const [flag, inlineValue] = argument.split("=", 2)
    const value = inlineValue ?? args[++index]
    switch (flag) {
      case "--sample":
        if (!value) throw new Error("--sample requires a sample id")
        options.sample = value
        break
      case "--limit":
        options.limit = readPositiveInteger("--limit", value)
        break
      case "--max-layer-combinations":
        options.maxLayerCombinations = readPositiveInteger(flag, value)
        break
      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

const options = parseOptions(Bun.argv.slice(2))
let selectedSamples = srj19FanoutSamples
if (options.sample) {
  selectedSamples = selectedSamples.filter(
    (sample) => sample.id === options.sample,
  )
  if (selectedSamples.length === 0) {
    throw new Error(`Unknown SRJ19 sample: ${options.sample}`)
  }
}
if (options.limit) selectedSamples = selectedSamples.slice(0, options.limit)

const rows: Array<Record<string, string | number>> = []
let solvedCount = 0
let totalRoutedConnections = 0
let totalFanoutConnections = 0
let totalMilliseconds = 0

for (const sample of selectedSamples) {
  const startTime = performance.now()
  try {
    const solver = new FanoutSolver(sample.simpleRouteJson, {
      ...sample.solverOptions,
      ...(options.maxLayerCombinations
        ? { maxLayerCombinations: options.maxLayerCombinations }
        : {}),
    })
    solver.solve()
    const elapsedMilliseconds = performance.now() - startTime
    const bestAttempt = solver.attempts.toSorted(
      (first, second) => first.score - second.score,
    )[0]
    const routedConnections = bestAttempt?.routedConnectionCount ?? 0
    const viaCount = solver.solved
      ? solver
          .getOutput()
          .fanoutTraces.filter((trace) =>
            trace.route.some((point) => point.route_type === "via"),
          ).length
      : "-"

    if (solver.solved) solvedCount++
    totalRoutedConnections += routedConnections
    totalFanoutConnections += sample.fanoutConnectionCount
    totalMilliseconds += elapsedMilliseconds
    rows.push({
      sample: sample.id,
      status: solver.solved ? "solved" : "partial",
      bgaPads: sample.bgaPadCount,
      components: sample.componentCount,
      obstacles: sample.obstacleCount,
      connections: sample.fanoutConnectionCount,
      routed: routedConnections,
      completion: `${((routedConnections / sample.fanoutConnectionCount) * 100).toFixed(1)}%`,
      attempts: solver.attempts.length,
      vias: viaCount,
      milliseconds: Number(elapsedMilliseconds.toFixed(2)),
    })
  } catch (error) {
    const elapsedMilliseconds = performance.now() - startTime
    totalFanoutConnections += sample.fanoutConnectionCount
    totalMilliseconds += elapsedMilliseconds
    rows.push({
      sample: sample.id,
      status: "error",
      bgaPads: sample.bgaPadCount,
      components: sample.componentCount,
      obstacles: sample.obstacleCount,
      connections: sample.fanoutConnectionCount,
      routed: 0,
      completion: "0.0%",
      attempts: 0,
      vias: "-",
      milliseconds: Number(elapsedMilliseconds.toFixed(2)),
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

console.table(rows)
console.log({
  samples: selectedSamples.length,
  solved: solvedCount,
  routedConnections: `${totalRoutedConnections}/${totalFanoutConnections}`,
  completion:
    totalFanoutConnections === 0
      ? "0.0%"
      : `${((totalRoutedConnections / totalFanoutConnections) * 100).toFixed(1)}%`,
  milliseconds: Number(totalMilliseconds.toFixed(2)),
})
