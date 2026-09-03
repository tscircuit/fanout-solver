import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "../lib/types"

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
  error?: string
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
