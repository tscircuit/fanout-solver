import type { BenchmarkReport } from "./benchmark-types"

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("@", "&#64;")
    .replaceAll("\n", " ")

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const { rows, configuration } = report
  const lines = [
    "# Dataset 31 — AM62L, RK3308, K230, i.MX6ULL, T113-S3, and AM3352 fanout benchmark",
    "",
    `Commit: ${report.commit ?? "unknown"}. Generated: ${report.generatedAt}.`,
    `Dataset source: ${report.datasetSource.repository} at ${report.datasetSource.commit}.`,
    "",
    `**Solved ${rows.filter((row) => row.status === "solved").length}/${report.totalSamples} selected samples.** Completed ${rows.length}/${report.totalSamples}; partial: ${rows.filter((row) => row.status === "partial").length}; errors: ${rows.filter((row) => row.status === "error").length}; timeouts: ${rows.filter((row) => row.status === "timeout").length}.`,
    "",
    `Concurrency: ${configuration.concurrency}; per-sample timeout: ${configuration.sampleTimeoutSeconds}s; assignment budget: ${configuration.maxLayerCombinations ?? "sample defaults"}; wall time: ${(report.wallClockMilliseconds / 1000).toFixed(2)}s.`,
    "",
    "Only dataset-fanout31-am62l is benchmarked: 12 AM62L, 12 RK3308, 12 K230, 12 i.MX6ULL, 12 T113-S3, and 12 AM3352 cases. A case is solved only when all its SoC connections have validated fanout with the original clearance and length-skew constraints (135 for AM62L; 162 for RK3308; 171 for K230; 102 for i.MX6ULL; 128 for T113-S3; 322 for AM3352). RAM fanout and inter-chip routing are separate phases.",
    "",
    "Turn density is each trace's maximum number of completed 90° heading changes within 5 mm along the trace. Opposing 45° bends cancel. Medians below use only validated solved cases; signal traces exclude plane terminations. The aggregate trace-weighted medians and four highest-scoring complete solver visualizations are in [trace-turn-density.svg](trace-turn-density.svg), with per-trace measurements in [trace-turn-density.json](trace-turn-density.json).",
  ]
  lines.push(
    "",
    "| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds | Median 5 mm 90° turns (all) | Median 5 mm 90° turns (signal) |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  )
  for (const row of rows)
    lines.push(
      `| ${escapeXml(row.sample)} | ${row.status} | ${row.routed}/${row.connections} | ${row.validatedBreakouts ?? "—"} | ${row.vias ?? "—"} | ${row.attempts} | ${(row.milliseconds / 1000).toFixed(2)} | ${row.turnDensity?.median ?? "—"} | ${row.signalTurnDensity?.median ?? "—"} |`,
    )
  for (const row of rows.filter((row) => row.error))
    lines.push(
      "",
      `- ${escapeXml(`${row.dataset}/${row.sample}`)}: ${escapeXml(row.error!)}`,
    )
  return `${lines.join("\n")}\n`
}
