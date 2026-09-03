import type { BenchmarkReport } from "./benchmark-types"

const escape = (value: string) =>
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
    "# Dataset 31 — AM62L fanout benchmark",
    "",
    `Commit: ${report.commit ?? "unknown"}. Generated: ${report.generatedAt}.`,
    `Dataset source: ${report.datasetSource.repository} at ${report.datasetSource.commit}.`,
    "",
    `**Solved ${rows.filter((row) => row.status === "solved").length}/${report.totalSamples} selected samples.** Completed ${rows.length}/${report.totalSamples}; partial: ${rows.filter((row) => row.status === "partial").length}; errors: ${rows.filter((row) => row.status === "error").length}; timeouts: ${rows.filter((row) => row.status === "timeout").length}.`,
    "",
    `Concurrency: ${configuration.concurrency}; per-sample timeout: ${configuration.sampleTimeoutSeconds}s; assignment budget: ${configuration.maxLayerCombinations ?? "sample defaults"}; wall time: ${(report.wallClockMilliseconds / 1000).toFixed(2)}s.`,
    "",
    "Only dataset-fanout31-am62l is benchmarked. Solved means all 135 AM62L connections have validated fanout with the original clearance and length-skew constraints. It does not imply RAM fanout or inter-chip routing.",
  ]
  lines.push(
    "",
    "| Sample | Status | Routed | Validated breakouts | Vias | Attempts | Seconds |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  )
  for (const row of rows)
    lines.push(
      `| ${escape(row.sample)} | ${row.status} | ${row.routed}/${row.connections} | ${row.validatedBreakouts ?? "—"} | ${row.vias ?? "—"} | ${row.attempts} | ${(row.milliseconds / 1000).toFixed(2)} |`,
    )
  for (const row of rows.filter((row) => row.error))
    lines.push(
      "",
      `- ${escape(`${row.dataset}/${row.sample}`)}: ${escape(row.error!)}`,
    )
  return `${lines.join("\n")}\n`
}
