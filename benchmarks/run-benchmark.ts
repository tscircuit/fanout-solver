import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDatasets } from "../datasets"

const rows: Array<Record<string, string | number>> = []
for (const dataset of fanoutDatasets) {
  for (const sample of dataset.samples) {
    const srj = sample.simpleRouteJson
    const solver = new FanoutSolver(srj, sample.solverOptions)
    const startTime = performance.now()
    solver.solve()
    const elapsedMilliseconds = performance.now() - startTime
    const output = solver.getOutput()
    const viaCount = output.fanoutTraces.filter((trace) =>
      trace.route.some((routePoint) => routePoint.route_type === "via"),
    ).length
    rows.push({
      dataset: dataset.id,
      sample: sample.id,
      layers: srj.layerCount,
      footprints: sample.footprintCount,
      pads: srj.obstacles.filter((obstacle) => obstacle.componentId).length,
      connections: srj.connections.length,
      vias: viaCount,
      viaFreeBuses: Object.values(output.busLayerAssignments).filter(
        (layer) => layer === "top",
      ).length,
      attempts: output.attempts.length,
      routed: output.fanoutTraces.length,
      milliseconds: Number(elapsedMilliseconds.toFixed(2)),
    })
  }
}

console.table(rows)
