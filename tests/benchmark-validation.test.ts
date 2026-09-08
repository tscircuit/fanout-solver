import { expect, test } from "bun:test"
import type { BenchmarkSample } from "../benchmarks/benchmark-types"
import { solveBenchmarkSample } from "../benchmarks/benchmark-worker"
import { createAm62lRamLeftSubset } from "../datasets/dataset08"

test("benchmark worker requires validated AM62L fanout and records constructor errors", () => {
  // A reduced bus keeps this worker unit test fast; the actual catalog always
  // captures all 135 connections from each upstream sample.
  const sample: BenchmarkSample = {
    dataset: "dataset31",
    id: "worker-unit-test",
    ...createAm62lRamLeftSubset({ busIds: ["DDR_BYTE1"] }),
  }
  const row = solveBenchmarkSample(sample, 1)
  expect(row.status).toBe("solved")
  expect(row.scope).toBe("fanout")
  expect(row.connections).toBe(8)
  expect(row.validatedBreakouts).toBe(row.connections)
  expect(row.svg).toContain("<svg")
  expect(row.svg).not.toMatch(/[\t ]+\n/)
  expect(row.turnDensitySamples).toHaveLength(8)
  expect(row.turnDensity?.traceCount).toBe(8)
  expect(row.turnDensity?.median).toBeNumber()
  expect(row.signalTurnDensity).toEqual(row.turnDensity)
  for (const measured of row.turnDensitySamples!) {
    expect(measured.sample).toBe(sample.id)
    expect(measured.metric.pcbTraceId).toBe(measured.trace.pcb_trace_id)
    expect(measured.metric.max90DegreeTurns).toBeGreaterThanOrEqual(0)
    expect(measured.metric.spanMm).toBe(5)
    expect(measured.isPlaneTermination).toBe(false)
  }
  const invalid = solveBenchmarkSample({
    ...sample,
    solverOptions: { ...sample.solverOptions, viaDiameter: -1 },
  })
  expect(invalid.status).toBe("error")
  expect(invalid.error).toBeTruthy()
  expect(invalid.svg).toBeUndefined()
  expect(invalid.turnDensitySamples).toBeUndefined()
  expect(invalid.turnDensity).toBeUndefined()
  expect(invalid.signalTurnDensity).toBeUndefined()
}, 30_000)
