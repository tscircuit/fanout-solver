import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset01 } from "../datasets/dataset01"

const rows: Array<Record<string, string | number>> = []
for (const sample of fanoutDataset01) {
  const srj = sample.simpleRouteJson
  const solver = new FanoutSolver(srj)
  const startTime = performance.now()
  solver.solve()
  const elapsedMilliseconds = performance.now() - startTime
  const output = solver.getOutput()
  rows.push({
    sample: sample.id,
    footprints: sample.footprintCount,
    pads: srj.obstacles.length,
    connections: srj.connections.length,
    attempts: output.attempts.length,
    routed: output.fanoutTraces.length,
    milliseconds: Number(elapsedMilliseconds.toFixed(2)),
  })
}

console.table(rows)
