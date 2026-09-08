import type { FanoutSimplifiedPcbTrace, Point2D } from "./types"

const DISTANCE_EPSILON = 1e-9
const ANGLE_EPSILON = 1e-7
const SPAN_MM = 5

export interface TraceTurn extends Point2D {
  /** Centerline distance from the start of this continuous copper section. */
  distanceMm: number
  angleDegrees: number
}

export interface TraceTurnWindow {
  sectionIndex: number
  layer: string
  startDistanceMm: number
  endDistanceMm: number
  turnCount: number
  points: Point2D[]
  turns: TraceTurn[]
}

export interface TraceTurnDensityMetric {
  pcbTraceId: string
  connectionName: string
  spanMm: 5
  traceLengthMm: number
  max90DegreeTurns: number
  worstWindow: TraceTurnWindow | null
}

interface Section {
  layer: string
  points: (Point2D & { distanceMm: number })[]
}

function getSections(trace: FanoutSimplifiedPcbTrace): Section[] {
  const sections: Section[] = []
  let section: Section | undefined
  for (const point of trace.route) {
    if (
      (point.route_type === "wire" || point.route_type === "via") &&
      (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    )
      throw new Error(`Non-finite route coordinate in ${trace.pcb_trace_id}`)
    if (point.route_type !== "wire") {
      section = undefined
      continue
    }
    if (!section || section.layer !== point.layer) {
      section = { layer: point.layer, points: [] }
      sections.push(section)
    }
    const previous = section.points.at(-1)
    const length = previous
      ? Math.hypot(point.x - previous.x, point.y - previous.y)
      : 0
    if (previous && length <= DISTANCE_EPSILON) continue
    section.points.push({
      x: point.x,
      y: point.y,
      distanceMm: (previous?.distanceMm ?? 0) + length,
    })
  }
  return sections
}

function getTurns(section: Section): TraceTurn[] {
  const turns: TraceTurn[] = []
  for (let i = 1; i < section.points.length - 1; i++) {
    const a = section.points[i - 1]!
    const b = section.points[i]!
    const c = section.points[i + 1]!
    const ux = b.x - a.x
    const uy = b.y - a.y
    const vx = c.x - b.x
    const vy = c.y - b.y
    const angleDegrees =
      (Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180) / Math.PI
    if (Math.abs(angleDegrees) <= ANGLE_EPSILON) continue
    turns.push({ ...b, angleDegrees })
  }
  return turns
}

function countTurns(turns: TraceTurn[]): number {
  let count = 0
  let run = 0
  const flush = () => {
    count += Math.floor((Math.abs(run) + ANGLE_EPSILON) / 90)
    run = 0
  }
  for (const turn of turns) {
    // At exactly 180 degrees the sign of atan2 is ambiguous. Counting the
    // reversal independently preserves reflection and traversal invariance.
    if (Math.abs(Math.abs(turn.angleDegrees) - 180) <= ANGLE_EPSILON) {
      flush()
      count += 2
      continue
    }
    if (run !== 0 && Math.sign(run) !== Math.sign(turn.angleDegrees)) flush()
    run += turn.angleDegrees
  }
  flush()
  return count
}

function pointAt(section: Section, distanceMm: number): Point2D {
  for (let i = 1; i < section.points.length; i++) {
    const a = section.points[i - 1]!
    const b = section.points[i]!
    if (b.distanceMm < distanceMm) continue
    const t = (distanceMm - a.distanceMm) / (b.distanceMm - a.distanceMm)
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
  }
  const end = section.points.at(-1)!
  return { x: end.x, y: end.y }
}

/**
 * Maximum completed 90-degree bends in a 5 mm centerline window.
 * Within each window, consecutive bends in the same direction form a run:
 * sum floor(abs(run angle) / 90). +45,+45 counts 1; +45,-45 counts 0;
 * +90,-90 counts 2. Fractional turns never carry between runs or windows.
 *
 * Windows include bends on their endpoints and are restricted to continuous
 * same-layer wire sections. Vias/layer changes reset heading and windows;
 * via barrels do not contribute planar length. Sections shorter than 5 mm
 * use their entire length. Duplicate points and collinear vertices are ignored.
 */
export function measureTraceTurnDensity(
  trace: FanoutSimplifiedPcbTrace,
): TraceTurnDensityMetric {
  let worstWindow: TraceTurnWindow | null = null
  let traceLengthMm = 0
  for (const [sectionIndex, section] of getSections(trace).entries()) {
    const length = section.points.at(-1)?.distanceMm ?? 0
    traceLengthMm += length
    if (section.points.length < 2) continue
    const turns = getTurns(section)
    // Any maximizing set of bend events fits in a window starting at its
    // first event (or the final full window). Adding events cannot lower the
    // run count, so these candidates cover the continuous sliding maximum.
    const starts = new Set([
      0,
      ...turns.map((turn) =>
        Math.min(turn.distanceMm, Math.max(0, length - SPAN_MM)),
      ),
    ])
    for (const start of starts) {
      const end = Math.min(length, start + SPAN_MM)
      const windowTurns = turns.filter(
        (turn) =>
          turn.distanceMm >= start - DISTANCE_EPSILON &&
          turn.distanceMm <= end + DISTANCE_EPSILON,
      )
      const turnCount = countTurns(windowTurns)
      if (
        worstWindow &&
        (turnCount < worstWindow.turnCount ||
          (turnCount === worstWindow.turnCount &&
            end - start <=
              worstWindow.endDistanceMm -
                worstWindow.startDistanceMm +
                DISTANCE_EPSILON))
      )
        continue
      worstWindow = {
        sectionIndex,
        layer: section.layer,
        startDistanceMm: start,
        endDistanceMm: end,
        turnCount,
        points: [
          pointAt(section, start),
          ...section.points
            .filter(
              (point) => point.distanceMm > start && point.distanceMm < end,
            )
            .map(({ x, y }) => ({ x, y })),
          pointAt(section, end),
        ],
        turns: windowTurns,
      }
    }
  }
  return {
    pcbTraceId: trace.pcb_trace_id,
    connectionName: trace.connection_name,
    spanMm: SPAN_MM,
    traceLengthMm,
    max90DegreeTurns: worstWindow?.turnCount ?? 0,
    worstWindow,
  }
}

export function summarizeTraceTurnDensity(metrics: TraceTurnDensityMetric[]) {
  const values = metrics
    .map((metric) => metric.max90DegreeTurns)
    .sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  return {
    traceCount: values.length,
    median:
      values.length === 0
        ? null
        : values.length % 2
          ? values[middle]!
          : (values[middle - 1]! + values[middle]!) / 2,
    max: values.at(-1) ?? null,
  }
}

/** Opt-in quality budget; the caller chooses the limit, not a DDR design rule. */
export function checkTraceTurnDensity(
  traces: FanoutSimplifiedPcbTrace[],
  options: { max90DegreeTurns: number },
) {
  if (
    !Number.isSafeInteger(options.max90DegreeTurns) ||
    options.max90DegreeTurns < 0
  )
    throw new Error("max90DegreeTurns must be a non-negative integer")
  const metrics = traces.map(measureTraceTurnDensity)
  const issues = metrics
    .filter((metric) => metric.max90DegreeTurns > options.max90DegreeTurns)
    .map(({ pcbTraceId, connectionName, max90DegreeTurns }) => ({
      pcbTraceId,
      connectionName,
      max90DegreeTurns,
    }))
  return {
    valid: issues.length === 0,
    limit: options.max90DegreeTurns,
    summary: summarizeTraceTurnDensity(metrics),
    traces: metrics,
    issues,
  }
}
