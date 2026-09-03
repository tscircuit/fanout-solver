import { expect, test } from "bun:test"
import { selectBenchmarkSamples } from "../benchmarks/benchmark-catalog"
import { solveBenchmarkSample } from "../benchmarks/benchmark-worker"

test("benchmark preserves SRJ29 endpoint and DRC validation and records constructor errors", () => {
  const sample = selectBenchmarkSamples({ sample: "srj29/sample001" })[0]!
  const row = solveBenchmarkSample(sample)
  expect(row.status).toBe("solved")
  expect(row.scope).toBe("original-endpoints")
  expect(row.validatedBreakouts).toBe(row.connections)
  expect(row.connectedOriginalConnections).toBe(row.connections)
  expect(row.routedCopperDrcValid).toBe(true)
  const invalid = solveBenchmarkSample({
    ...sample,
    solverOptions: { ...sample.solverOptions, viaDiameter: -1 },
  })
  expect(invalid.status).toBe("error")
  expect(invalid.error).toBeTruthy()
}, 30_000)
