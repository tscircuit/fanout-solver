import { readFileSync } from "node:fs"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "../lib/fanout-solver"
import {
  measureTraceTurnDensity,
  summarizeTraceTurnDensity,
} from "../lib/measure-trace-turn-density"
import type { BenchmarkSample, BenchmarkWorkerResult } from "./benchmark-types"

export function solveBenchmarkSample(
  sample: BenchmarkSample,
  maxLayerCombinations?: number,
): BenchmarkWorkerResult {
  const startedAt = performance.now()
  let solvedSolver: FanoutSolver | undefined
  const row: BenchmarkWorkerResult = {
    dataset: sample.dataset,
    sample: sample.id,
    status: "error",
    scope: "fanout",
    connections: sample.simpleRouteJson.connections.length,
    routed: 0,
    validatedBreakouts: null,
    attempts: 0,
    vias: null,
    milliseconds: 0,
  }
  try {
    const solver = new FanoutSolver(sample.simpleRouteJson, {
      ...sample.solverOptions,
      ...(maxLayerCombinations === undefined ? {} : { maxLayerCombinations }),
    })
    solver.solve()
    row.attempts = solver.attempts.length
    row.routed = Math.max(
      0,
      ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
    )
    row.status = "partial"
    if (solver.solved) {
      const output = solver.getOutput()
      row.validatedBreakouts = output.validation.brokenOutConnectionCount
      row.routed = row.validatedBreakouts
      row.vias = output.fanoutTraces.reduce(
        (count, trace) =>
          count +
          trace.route.filter((point) => point.route_type === "via").length,
        0,
      )
      const fanoutValid =
        output.validation.valid &&
        output.validation.checkedConnectionCount === row.connections &&
        row.validatedBreakouts === row.connections
      if (fanoutValid) {
        row.status = "solved"
        solvedSolver = solver
      }
    } else row.error = solver.error ?? "No complete validated solution"
  } catch (error) {
    row.status = "error"
    row.error = error instanceof Error ? error.message : String(error)
  }
  row.milliseconds = Math.round(performance.now() - startedAt)
  // Preserve solver timing; measure/render only complete, validated solutions.
  if (solvedSolver) {
    const output = solvedSolver.getOutput()
    const planeConnections = new Set(
      output.planeTerminations.map((termination) => termination.connectionName),
    )
    row.turnDensitySamples = output.fanoutTraces.map((trace) => ({
      sample: sample.id,
      trace,
      metric: measureTraceTurnDensity(trace),
      isPlaneTermination: planeConnections.has(trace.connection_name),
    }))
    row.turnDensity = summarizeTraceTurnDensity(
      row.turnDensitySamples.map(({ metric }) => metric),
    )
    row.signalTurnDensity = summarizeTraceTurnDensity(
      row.turnDensitySamples
        .filter(({ isPlaneTermination }) => !isPlaneTermination)
        .map(({ metric }) => metric),
    )
    row.svg = `${getSvgFromGraphicsObject(solvedSolver.visualize())
      .trimEnd()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")}\n`
  }
  return row
}

if (import.meta.main) {
  const { sample, maxLayerCombinations } = JSON.parse(readFileSync(0, "utf8"))
  console.log(
    JSON.stringify(solveBenchmarkSample(sample, maxLayerCombinations)),
  )
}
