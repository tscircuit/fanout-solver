import {
  summarizeTraceTurnDensity,
  type TraceTurnDensityMetric,
} from "../lib/measure-trace-turn-density"
import type { FanoutSimplifiedPcbTrace } from "../lib/types"

export interface TraceTurnDensitySample {
  sample: string
  trace: FanoutSimplifiedPcbTrace
  metric: TraceTurnDensityMetric
  isPlaneTermination?: boolean
}

export interface FanoutTurnDensitySample {
  sample: string
  traces: TraceTurnDensitySample[]
  summary: ReturnType<typeof summarizeTraceTurnDensity>
  signalSummary: ReturnType<typeof summarizeTraceTurnDensity>
}

/** Select complete fanout problems, not isolated traces. */
export function selectTraceTurnDensitySamples(
  traces: TraceTurnDensitySample[],
  sampleIds?: string[],
): FanoutTurnDensitySample[] {
  const grouped = new Map<string, TraceTurnDensitySample[]>()
  for (const trace of traces) {
    const sample = grouped.get(trace.sample) ?? []
    sample.push(trace)
    grouped.set(trace.sample, sample)
  }
  const samples = [...grouped].map(([sample, traces]) => ({
    sample,
    traces,
    summary: summarizeTraceTurnDensity(traces.map(({ metric }) => metric)),
    signalSummary: summarizeTraceTurnDensity(
      traces
        .filter((trace) => !trace.isPlaneTermination)
        .map(({ metric }) => metric),
    ),
  }))
  if (sampleIds) {
    if (sampleIds.length > 4 || new Set(sampleIds).size !== sampleIds.length)
      throw new Error("Select at most four distinct fanout sample IDs")
    return sampleIds.map((id) => {
      const sample = samples.find((sample) => sample.sample === id)
      if (!sample) throw new Error(`Unknown fanout sample: ${id}`)
      return sample
    })
  }
  samples.sort(
    (a, b) =>
      (b.summary.max ?? 0) - (a.summary.max ?? 0) ||
      (b.signalSummary.median ?? b.summary.median ?? 0) -
        (a.signalSummary.median ?? a.summary.median ?? 0) ||
      a.sample.localeCompare(b.sample),
  )
  if (samples.length <= 4) return samples
  return samples.slice(0, 4)
}

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
const label = (x: number, y: number, value: string, size = 18, extra = "") =>
  `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="#172033" ${extra}>${escapeXml(value)}</text>`
const count = (value: number | null) => (value === null ? "—" : String(value))

/** Embed the original solver drawing, preserving its viewBox, geometry and styling. */
function embedSolverSvg(
  svg: string,
  x: number,
  y: number,
  sample: string,
): string {
  const root = svg.match(/<svg\b([^>]*)>/)
  const end = svg.lastIndexOf("</svg>")
  if (!root || end < (root.index ?? 0))
    throw new Error(`Missing valid solver SVG for ${sample}`)
  const viewBox = root[1]!.match(/\bviewBox="([^"]+)"/)?.[1]
  if (!viewBox) throw new Error(`Missing solver SVG viewBox for ${sample}`)
  const content = svg.slice((root.index ?? 0) + root[0].length, end)
  // Native tooltip scripts query the entire document and conflict when four
  // independent drawings are composed. Their removal does not alter geometry.
  const drawing = content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
  return `<svg x="${x}" y="${y}" width="820" height="820" viewBox="${escapeXml(viewBox)}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" data-solver-sample="${escapeXml(sample)}">${drawing}</svg>`
}

/** Four complete native solver visualizations, with per-problem turn counts. */
export function renderTraceTurnDensitySvg(
  traces: TraceTurnDensitySample[],
  options: {
    sampleSvgs: Record<string, string>
    sampleIds?: string[]
    subtitle?: string
  },
): string {
  const all = summarizeTraceTurnDensity(traces.map(({ metric }) => metric))
  const signals = summarizeTraceTurnDensity(
    traces
      .filter((trace) => !trace.isPlaneTermination)
      .map(({ metric }) => metric),
  )
  const samples = selectTraceTurnDensitySamples(traces, options.sampleIds)
  const panels = samples
    .map((sample, index) => {
      const x = 32 + (index % 2) * 880
      const y = 144 + Math.floor(index / 2) * 940
      const svg = options.sampleSvgs[sample.sample]
      if (!svg) throw new Error(`Missing solver SVG for ${sample.sample}`)
      return `<g class="sample-panel">
      <rect x="${x}" y="${y}" width="856" height="916" fill="white" stroke="#c9d0da"/>
      ${label(x + 18, y + 30, sample.sample, 24, 'font-weight="700"')}
      ${label(x + 838, y + 30, `${sample.summary.traceCount} traces · ${sample.signalSummary.traceCount} signals`, 16, 'text-anchor="end"')}
      ${label(x + 18, y + 62, `All-trace median: ${count(sample.summary.median)}  ·  Signal median: ${count(sample.signalSummary.median)}  ·  Maximum: ${count(sample.summary.max)}`, 21)}
      ${embedSolverSvg(svg, x + 18, y + 80, sample.sample)}
    </g>`
    })
    .join("\n")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="2080" viewBox="0 0 1800 2080" role="img" aria-labelledby="title description">
    <title id="title">Fanout samples — 5mm 90 degree turns</title>
    <desc id="description">Four complete fanout samples drawn by the solver, with the median and maximum per-trace turn counts for each sample.</desc>
    <rect width="1800" height="2080" fill="white"/>
    ${label(32, 45, "Fanout samples — 5mm 90 degree turns", 34, 'font-weight="700"')}
    ${label(32, 78, options.subtitle ?? "Complete FanoutSolver visualizations", 19)}
    ${label(32, 113, `Overall median: ${count(all.median)} across ${all.traceCount.toLocaleString("en-US")} traces    ·    Signal median: ${count(signals.median)} across ${signals.traceCount.toLocaleString("en-US")} signals    ·    Maximum: ${count(all.max)}`, 23, 'font-weight="700"')}
    ${panels}
    ${samples.length ? "" : label(900, 550, "No complete validated routes yet", 25, 'text-anchor="middle"')}
    ${label(32, 2034, "Each trace: maximum completed 90° turns within 5 mm along its centerline. Panel medians summarize the traces in that sample.", 18)}
    ${label(32, 2062, "+45° then +45° = 1; +45° then −45° = 0. Windows stop at vias/layer changes. Signals exclude plane terminations.", 18)}
  </svg>\n`.replace(/[ \t]+\n/g, "\n")
}
