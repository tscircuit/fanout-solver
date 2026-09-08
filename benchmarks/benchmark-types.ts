import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { TraceTurnDensityMetric } from "../lib/measure-trace-turn-density"
import type {
  FanoutSimplifiedPcbTrace,
  FanoutSolverOptions,
} from "../lib/types"

export interface BenchmarkTurnDensitySummary {
  traceCount: number
  median: number | null
  max: number | null
}

export interface BenchmarkTurnDensitySample {
  sample: string
  trace: FanoutSimplifiedPcbTrace
  metric: TraceTurnDensityMetric
  isPlaneTermination: boolean
}

export interface BenchmarkSample {
  dataset: "dataset31"
  id: string
  simpleRouteJson: SimpleRouteJson
  solverOptions?: FanoutSolverOptions
}

export interface BenchmarkRow {
  dataset: "dataset31"
  sample: string
  status: "solved" | "partial" | "error" | "timeout"
  scope: "fanout"
  connections: number
  routed: number
  validatedBreakouts: number | null
  attempts: number
  vias: number | null
  milliseconds: number
  turnDensity?: BenchmarkTurnDensitySummary
  signalTurnDensity?: BenchmarkTurnDensitySummary
  error?: string
}

/** Worker-only payload; SVGs are saved separately from the compact reports. */
export interface BenchmarkWorkerResult extends BenchmarkRow {
  svg?: string
  turnDensitySamples?: BenchmarkTurnDensitySample[]
}

export interface BenchmarkConfiguration {
  concurrency: number
  sampleTimeoutSeconds: number
  maxLayerCombinations?: number
}

export interface BenchmarkReport {
  version: 2
  dataset: "dataset31"
  datasetSource: { repository: string; commit: string }
  generatedAt: string
  commit: string | null
  configuration: BenchmarkConfiguration
  wallClockMilliseconds: number
  totalSamples: number
  rows: BenchmarkRow[]
}
