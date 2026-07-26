import { FanoutSolver } from "lib/fanout-solver"
import { createFootprinterBenchmarkSrj } from "tests/fixtures/create-footprinter-benchmark"

const cases = [
  { name: "BGA36 / 6x6", gridSize: 6 },
  { name: "BGA64 / 8x8", gridSize: 8 },
  { name: "BGA100 / 10x10", gridSize: 10 },
]

const rows: Array<Record<string, string | number>> = []
for (const benchmarkCase of cases) {
  const srj = createFootprinterBenchmarkSrj({
    gridSize: benchmarkCase.gridSize,
  })
  const solver = new FanoutSolver(srj)
  const startTime = performance.now()
  solver.solve()
  const elapsedMilliseconds = performance.now() - startTime
  const output = solver.getOutput()
  rows.push({
    footprint: benchmarkCase.name,
    pads: benchmarkCase.gridSize ** 2,
    connections: srj.connections.length,
    attempts: output.attempts.length,
    routed: output.fanoutTraces.length,
    milliseconds: Number(elapsedMilliseconds.toFixed(2)),
  })
}

console.table(rows)
