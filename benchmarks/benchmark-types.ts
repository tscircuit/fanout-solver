import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "../lib/types"

export interface BenchmarkSample {
  dataset: string
  id: string
  simpleRouteJson: SimpleRouteJson
  solverOptions?: FanoutSolverOptions
  requireOriginalEndpoints: boolean
}

export interface BenchmarkRow {
  dataset: string
  sample: string
  status: "solved" | "partial" | "error" | "timeout"
  scope: "fanout" | "original-endpoints"
  connections: number
  routed: number
  validatedBreakouts: number | null
  connectedOriginalConnections: number | null
  routedCopperDrcValid: boolean | null
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
  version: 1
  generatedAt: string
  commit: string | null
  configuration: BenchmarkConfiguration
  wallClockMilliseconds: number
  totalSamples: number
  rows: BenchmarkRow[]
}
