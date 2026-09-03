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
    "# Fanout benchmark",
    "",
    `Commit: ${report.commit ?? "unknown"}. Generated: ${report.generatedAt}.`,
    "",
    `**Solved ${rows.filter((row) => row.status === "solved").length}/${report.totalSamples} selected samples.** Completed ${rows.length}/${report.totalSamples}; partial: ${rows.filter((row) => row.status === "partial").length}; errors: ${rows.filter((row) => row.status === "error").length}; timeouts: ${rows.filter((row) => row.status === "timeout").length}.`,
    "",
    `Concurrency: ${configuration.concurrency}; per-sample timeout: ${configuration.sampleTimeoutSeconds}s; assignment budget: ${configuration.maxLayerCombinations ?? "sample defaults"}; wall time: ${(report.wallClockMilliseconds / 1000).toFixed(2)}s.`,
    "",
    "Solved means validated fanout. Rows with original-endpoints scope additionally require complete original-endpoint connectivity and independently DRC-clean emitted copper (including SRJ29). It does not imply inter-chip routing for fanout-only samples.",
    "",
    "| Dataset | Solved / samples | Partial | Error | Timeout |",
    "| --- | ---: | ---: | ---: | ---: |",
  ]
  for (const dataset of new Set(rows.map((row) => row.dataset))) {
    const group = rows.filter((row) => row.dataset === dataset)
    lines.push(
      `| ${escape(dataset)} | ${group.filter((row) => row.status === "solved").length}/${group.length} | ${group.filter((row) => row.status === "partial").length} | ${group.filter((row) => row.status === "error").length} | ${group.filter((row) => row.status === "timeout").length} |`,
    )
  }
  lines.push(
    "",
    "| Sample | Status | Scope | Routed | Validated breakouts | Original endpoints | Copper DRC | Vias | Attempts | Seconds |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |",
  )
  for (const row of rows)
    lines.push(
      `| ${escape(`${row.dataset}/${row.sample}`)} | ${row.status} | ${row.scope} | ${row.routed}/${row.connections} | ${row.validatedBreakouts ?? "—"} | ${row.connectedOriginalConnections ?? "—"} | ${row.routedCopperDrcValid === null ? "—" : row.routedCopperDrcValid ? "clean" : "issues"} | ${row.vias ?? "—"} | ${row.attempts} | ${(row.milliseconds / 1000).toFixed(2)} |`,
    )
  for (const row of rows.filter((row) => row.error))
    lines.push(
      "",
      `- ${escape(`${row.dataset}/${row.sample}`)}: ${escape(row.error!)}`,
    )
  return `${lines.join("\n")}\n`
}
