import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { BenchmarkSample } from "../benchmarks/benchmark-types"
import { runSampleProcess } from "../benchmarks/run-sample-process"

test("a hung, crashed, or malformed benchmark worker cannot block subsequent samples", async () => {
  const sample: BenchmarkSample = {
    dataset: "dataset31",
    id: "timeout",
    simpleRouteJson: {
      layerCount: 2,
      minTraceWidth: 0.1,
      obstacles: [],
      connections: [
        { name: "a", pointsToConnect: [{ x: 0, y: 0, layer: "top" }] },
      ],
      bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
    },
  }
  const worker = fileURLToPath(
    new URL("./fixtures/benchmark-worker-fixture.ts", import.meta.url),
  )
  const statuses = []
  for (const id of ["timeout", "error", "malformed", "solved"]) {
    const row = await runSampleProcess(
      { ...sample, id },
      { concurrency: 1, sampleTimeoutSeconds: 0.5 },
      worker,
    )
    statuses.push(row.status)
    expect(row.milliseconds).toBeLessThan(3000)
  }
  expect(statuses).toEqual(["timeout", "error", "error", "solved"])
}, 10_000)
