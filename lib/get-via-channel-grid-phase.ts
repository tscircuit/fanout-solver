import type { Point2D } from "./types"

export interface ViaChannelGridSite {
  connectionIndex: number
  center: Point2D
  diameter: number
}

export interface ViaChannelGridPhaseParams {
  /** All physical vias spanning the layer, including future reservations. */
  vias: readonly ViaChannelGridSite[]
  /** Prefer channels incident to the connections currently being routed. */
  activeConnectionIndices: ReadonlySet<number>
  traceWidth: number
  clearance: number
  gridStep: number
}

interface PhaseWindow {
  start: number
  length: number
  active: boolean
}

const COORDINATE_EPSILON = 1e-9

/**
 * Choose one uniform-grid origin for the complete shared layer. Adjacent vias
 * define intervals in which two grid lanes can meet the exact trace pitch.
 * A circular interval sweep favors active channels, then all other channels.
 * Prefer the midpoint of a positive-width plateau to a fragile endpoint gain.
 * This is a search hint; callers must still validate all routed copper.
 */
export function getViaChannelGridPhase(
  params: ViaChannelGridPhaseParams,
): Point2D {
  const { vias, activeConnectionIndices, traceWidth, clearance, gridStep } =
    params
  for (const [name, value] of [
    ["traceWidth", traceWidth],
    ["gridStep", gridStep],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`FanoutSolver: ${name} must be positive and finite`)
  }
  if (!Number.isFinite(clearance) || clearance < 0)
    throw new Error("FanoutSolver: clearance must be non-negative and finite")
  for (const via of vias) {
    if (
      !Number.isSafeInteger(via.connectionIndex) ||
      via.connectionIndex < 0 ||
      !Number.isFinite(via.center.x) ||
      !Number.isFinite(via.center.y) ||
      !Number.isFinite(via.diameter) ||
      via.diameter <= 0
    )
      throw new Error("FanoutSolver: invalid via channel grid site")
  }

  const modulo = (value: number) => ((value % gridStep) + gridStep) % gridStep
  const centered = (value: number) => {
    const phase = modulo(value + gridStep / 2) - gridStep / 2
    return Math.abs(phase) < Number.EPSILON ? 0 : phase
  }
  const ratio = (traceWidth + clearance) / gridStep
  // Correct only floating-point evaluation of an integer ratio, not geometry.
  const laneSteps = Math.ceil(
    ratio - Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4,
  )
  const phaseTolerance = Number.EPSILON * Math.max(1, gridStep) * 32

  const getAxisPhase = (axis: "x" | "y"): number => {
    const other = axis === "x" ? "y" : "x"
    const ordered = vias.toSorted(
      (a, b) =>
        a.center[other] - b.center[other] ||
        a.center[axis] - b.center[axis] ||
        a.connectionIndex - b.connectionIndex,
    )
    const rows: ViaChannelGridSite[][] = []
    for (const via of ordered) {
      const row = rows.at(-1)
      if (
        row &&
        Math.abs(row[0]!.center[other] - via.center[other]) <=
          COORDINATE_EPSILON
      )
        row.push(via)
      else rows.push([via])
    }
    const windows: PhaseWindow[] = []
    for (const row of rows) {
      row.sort((a, b) => a.center[axis] - b.center[axis])
      for (let index = 1; index < row.length; index++) {
        const first = row[index - 1]!,
          second = row[index]!
        const start =
          first.center[axis] + first.diameter / 2 + traceWidth / 2 + clearance
        const end =
          second.center[axis] -
          second.diameter / 2 -
          traceWidth / 2 -
          clearance -
          laneSteps * gridStep
        if (!Number.isFinite(start) || !Number.isFinite(end))
          throw new Error("FanoutSolver: non-finite via channel bounds")
        if (end < start - phaseTolerance) continue
        windows.push({
          start: modulo(start),
          length: Math.max(0, end - start),
          active:
            activeConnectionIndices.has(first.connectionIndex) ||
            activeConnectionIndices.has(second.connectionIndex),
        })
      }
    }
    const endpoints = windows
      .filter((window) => window.length < gridStep - phaseTolerance)
      .flatMap((window) => [window.start, modulo(window.start + window.length)])
      .sort((a, b) => a - b)
      .filter(
        (point, index, points) =>
          index === 0 || point - points[index - 1]! > phaseTolerance,
      )
    if (endpoints.length === 0) return 0

    const score = (phase: number): [number, number] => {
      let active = 0,
        total = 0
      for (const window of windows) {
        if (
          window.length >= gridStep - phaseTolerance ||
          modulo(phase - window.start) <= window.length + phaseTolerance
        ) {
          total++
          if (window.active) active++
        }
      }
      return [active, total]
    }
    let best = { active: -1, total: -1, width: 0, phase: 0 }
    const consider = (phase: number, width: number) => {
      phase = centered(phase)
      const [active, total] = score(phase)
      if (
        active > best.active ||
        (active === best.active &&
          (total > best.total ||
            (total === best.total &&
              (width > best.width + phaseTolerance ||
                (Math.abs(width - best.width) <= phaseTolerance &&
                  (Math.abs(phase) < Math.abs(best.phase) - phaseTolerance ||
                    (Math.abs(Math.abs(phase) - Math.abs(best.phase)) <=
                      phaseTolerance &&
                      phase < best.phase)))))))
      )
        best = { active, total, width, phase }
    }
    for (let index = 0; index < endpoints.length; index++) {
      const start = endpoints[index]!
      const end = endpoints[index + 1] ?? endpoints[0]! + gridStep
      if (end - start > phaseTolerance) consider((start + end) / 2, end - start)
    }
    // A zero-width-only channel has no robust phase. Retain its exact legal
    // phase as a fallback when no positive-width channel can be gained.
    if (best.total === 0)
      for (const endpoint of endpoints) consider(endpoint, 0)
    return best.phase
  }

  return { x: getAxisPhase("x"), y: getAxisPhase("y") }
}
