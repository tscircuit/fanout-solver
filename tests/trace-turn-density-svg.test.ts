import { expect, test } from "bun:test"
import { solveBenchmarkSample } from "../benchmarks/benchmark-worker"
import {
  renderTraceTurnDensitySvg,
  selectTraceTurnDensitySamples,
} from "../benchmarks/render-trace-turn-density-svg"
import { createAm62lRamLeftSubset } from "../datasets/dataset08"

test("trace quality report embeds native solver fanouts with their counts and median", () => {
  // Solve one reduced existing AM62L fixture, retaining its physical obstacles.
  // Reuse the solved drawing in four named groups to keep this report test fast.
  const row = solveBenchmarkSample(
    {
      dataset: "dataset31",
      id: "existing-am62l-fixture",
      ...createAm62lRamLeftSubset({ busIds: ["DDR_BYTE1"] }),
    },
    1,
  )
  expect(row.status).toBe("solved")
  expect(row.turnDensitySamples).toHaveLength(8)
  expect(row.svg).toContain("<polyline")
  const sampleIds = [
    "existing-case-01",
    "existing-case-02",
    "existing-case-03",
    "existing-case-04",
  ]
  const samples = sampleIds.flatMap((sample) =>
    row.turnDensitySamples!.map((trace) => ({ ...trace, sample })),
  )
  const sampleSvgs = Object.fromEntries(
    sampleIds.map((sample) => [sample, row.svg!]),
  )
  const selected = selectTraceTurnDensitySamples(samples, sampleIds)
  expect(selected.map(({ sample }) => sample)).toEqual(sampleIds)
  for (const group of selected) {
    expect(group.traces).toHaveLength(8)
    expect(group.summary).toEqual(row.turnDensity!)
    expect(group.signalSummary).toEqual(row.signalTurnDensity!)
  }
  const scores = [1, 10, 4, 9]
  const ranked = selectTraceTurnDensitySamples(
    samples.map((trace) => ({
      ...trace,
      metric: {
        ...trace.metric,
        max90DegreeTurns: scores[sampleIds.indexOf(trace.sample)]!,
      },
    })),
  )
  expect(ranked.map(({ sample }) => sample)).toEqual([
    "existing-case-02",
    "existing-case-04",
    "existing-case-03",
    "existing-case-01",
  ])

  const svg = renderTraceTurnDensitySvg(samples, {
    sampleSvgs,
    sampleIds,
    subtitle: "Existing AM62L fixture · native solver visualization",
  })
  for (const sample of sampleIds) expect(svg).toContain(sample)
  // Keep solver geometry verbatim: the report must not reconstruct or smooth
  // individual traces, remove other fanout geometry, or recolor its polylines.
  const nativePolylines = row.svg!.match(/<polyline\b[^>]*>/g)!
  expect(nativePolylines.length).toBeGreaterThan(8)
  for (const polyline of nativePolylines) expect(svg).toContain(polyline)
  expect(svg.match(/class="sample-panel"/g)).toHaveLength(4)
  expect(svg).toContain(
    `Overall median: ${row.turnDensity!.median} across 32 traces`,
  )
  expect(svg).toContain(
    `All-trace median: ${row.turnDensity!.median}  ·  Signal median: ${row.signalTurnDensity!.median}  ·  Maximum: ${row.turnDensity!.max}`,
  )
  expect(svg).toContain("+45° then −45° = 0")
  expect(svg).toMatchSvgSnapshot(import.meta.path)

  expect(() =>
    selectTraceTurnDensitySamples(samples, ["unknown-case"]),
  ).toThrow()
  expect(() => renderTraceTurnDensitySvg(samples, { sampleSvgs: {} })).toThrow()
  expect(selectTraceTurnDensitySamples([])).toEqual([])
  const empty = renderTraceTurnDensitySvg([], { sampleSvgs: {} })
  expect(empty).toContain("No complete validated")
  expect(empty).toContain("Overall median: — across 0 traces")

  // Zero is a measured result, not the placeholder for an empty report.
  const zero = {
    ...samples[0]!,
    metric: { ...samples[0]!.metric, max90DegreeTurns: 0 },
  }
  const zeros = renderTraceTurnDensitySvg([zero], { sampleSvgs })
  expect(zeros).toContain("Overall median: 0 across 1 traces")
  expect(zeros).toContain(
    "All-trace median: 0  ·  Signal median: 0  ·  Maximum: 0",
  )
  expect(zeros).not.toContain("median: —")
}, 30_000)
