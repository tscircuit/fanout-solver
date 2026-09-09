import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
  segmentsAreClear,
} from "./geometry"
import {
  addedTuningViasAreSelfClear,
  createPlanWithSegments,
} from "./match-bus-lengths"
import { changedFanoutCopperIsSelfClear } from "./normalize-fanout-plan-corners"
import type {
  Bounds,
  FanoutEdge,
  FanoutRoutePlan,
  Point2D,
  RoutedSegment,
} from "./types"

export interface BoundaryTerminalConnector {
  connectionName: string
  edge: FanoutEdge
  layer: string
  exit: Point2D
  goal: Point2D
}

/** Preserve the caller's exact boundary target; only the native goal moves. */
export function createBoundaryTerminalConnector(params: {
  connectionName: string
  edge: FanoutEdge
  layer: string
  exit: Point2D
  bounds: Bounds
  approachLength: number
}): BoundaryTerminalConnector {
  const { edge, bounds, exit, approachLength } = params
  if (!["left", "right", "top", "bottom"].includes(edge))
    throw new Error("Terminal approach requires a valid boundary edge")
  if (!Number.isFinite(approachLength) || approachLength <= 0)
    throw new Error("terminalApproachLength must be finite and positive")
  const horizontal = edge === "left" || edge === "right"
  const boundary =
    edge === "left"
      ? bounds.minX
      : edge === "right"
        ? bounds.maxX
        : edge === "bottom"
          ? bounds.minY
          : bounds.maxY
  const sign = edge === "left" || edge === "bottom" ? -1 : 1
  const goal = horizontal
    ? { x: exit.x - sign * approachLength, y: exit.y }
    : { x: exit.x, y: exit.y - sign * approachLength }
  if (
    ![
      exit.x,
      exit.y,
      goal.x,
      goal.y,
      bounds.minX,
      bounds.maxX,
      bounds.minY,
      bounds.maxY,
    ].every(Number.isFinite) ||
    Math.abs((horizontal ? exit.x : exit.y) - boundary) > 1e-7 ||
    goal.x <= bounds.minX ||
    goal.x >= bounds.maxX ||
    goal.y <= bounds.minY ||
    goal.y >= bounds.maxY
  )
    throw new Error(
      "Terminal approach must end on its shared edge and start inside it",
    )
  return {
    connectionName: params.connectionName,
    edge,
    layer: params.layer,
    exit: { ...exit },
    goal,
  }
}

/** Preserve a perpendicular tail, aligning with its lane through one 45-degree bend. */
export function getBoundaryTerminalEntry(
  start: Point2D,
  connector: BoundaryTerminalConnector,
): Point2D[] | null {
  const { goal, edge } = connector
  const horizontal = edge === "left" || edge === "right"
  const sign = edge === "left" || edge === "bottom" ? -1 : 1
  const normal = horizontal ? goal.x - start.x : goal.y - start.y
  const transverse = horizontal ? goal.y - start.y : goal.x - start.x
  const outwardDistance = sign * normal
  if (outwardDistance < Math.abs(transverse) - 1e-9) {
    if (outwardDistance <= 1e-9) return null
    // A nearby barrel can force entry from beside the goal. Align along the
    // transverse axis first, then turn 45 degrees onto the exact goal. The
    // following reserved tail adds only another 45-degree turn. The caller
    // checks both segments against the same static and negotiated copper.
    const bend = horizontal
      ? {
          x: start.x,
          y: goal.y - Math.sign(transverse) * outwardDistance,
        }
      : {
          x: goal.x - Math.sign(transverse) * outwardDistance,
          y: start.y,
        }
    return [start, bend, goal]
  }
  const bend = horizontal
    ? { x: start.x + sign * Math.abs(transverse), y: goal.y }
    : { x: goal.x, y: start.y + sign * Math.abs(transverse) }
  return [start, bend, goal].filter(
    (point, i, points) => i === 0 || distance(point, points[i - 1]!) > 1e-10,
  )
}

interface NeighborGrid {
  planeSize: number
  neighborOffset: Int32Array
  neighborIds: Int32Array
  neighborCosts: Float32Array
  cellCenterX: Float64Array
  cellCenterY: Float64Array
}

export interface TerminalConnectorRegion extends Bounds {}

const intersectsRegion = (
  regions: readonly TerminalConnectorRegion[],
  a: Point2D,
  b = a,
): boolean =>
  regions.some(
    (region) =>
      Math.max(a.x, b.x) >= region.minX &&
      Math.min(a.x, b.x) <= region.maxX &&
      Math.max(a.y, b.y) >= region.minY &&
      Math.min(a.y, b.y) <= region.maxY,
  )

/** The actual emitted path and the first appended entry segment, in path order. */
export interface BoundaryTerminalSplice {
  rawSegments: readonly RoutedSegment[]
  firstEntrySegmentIndex: number
}

/** Split only the audit view, retaining the complete path as hard own copper. */
function terminalSuffixAt(
  segments: readonly RoutedSegment[],
  point: Point2D,
  layer: string,
): { segments: RoutedSegment[]; changed: ReadonlySet<number> } | null {
  const positions: { index: number; offset: number }[] = []
  let length = 0
  for (const [index, segment] of segments.entries()) {
    if (
      segment.layer === layer &&
      distancePointToSegment(point, segment.start, segment.end) < 1e-8
    ) {
      const offset = length + distance(segment.start, point)
      if (!positions.some((p) => Math.abs(p.offset - offset) < 1e-8))
        positions.push({ index, offset })
    }
    length += distance(segment.start, segment.end)
  }
  // A self-crossing at the cut must not hide the earlier part of the entry.
  if (positions.length !== 1) return null
  let index = positions[0]!.index
  const original = segments[index]!
  const result = [...segments]
  if (distance(point, original.end) < 1e-8) index++
  else if (distance(point, original.start) > 1e-8) {
    result.splice(
      index,
      1,
      { ...original, end: point },
      { ...original, start: point },
    )
    index++
  }
  if (index >= result.length) return null
  return {
    segments: result,
    changed: new Set(result.slice(index).map((_, i) => index + i)),
  }
}

/** Check only actual entry copper, against every retained arm and physical hole. */
export function boundaryTerminalPlanIsSelfClear(params: {
  plan: FanoutRoutePlan
  splice: BoundaryTerminalSplice
  maximumJoinLength: number
  clearance: number
}): boolean {
  const { plan, splice, clearance, maximumJoinLength } = params
  const { rawSegments, firstEntrySegmentIndex: first } = splice
  if (
    !Number.isInteger(first) ||
    first < 0 ||
    first >= rawSegments.length ||
    !Number.isFinite(maximumJoinLength) ||
    maximumJoinLength < 0
  )
    return false
  const audit = (
    segments: readonly RoutedSegment[],
    changed: ReadonlySet<number>,
    physicalSegments: readonly RoutedSegment[] = segments,
  ): boolean => {
    const candidate = { ...plan, segments: [...segments] }
    const vias = [
      plan.via,
      ...(plan.additionalVias ?? []),
      plan.planeEndpointVia,
    ]
      .filter((via) => !!via)
      .filter((via) =>
        [...changed].some((index) => {
          const segment = segments[index]!
          return (
            via.spanLayers.includes(segment.layer) &&
            distancePointToSegment(via.center, segment.start, segment.end) <
              (via.diameter + segment.width) / 2 + clearance + 1e-7
          )
        }),
      )
    return (
      addedTuningViasAreSelfClear(
        { ...candidate, segments: [...physicalSegments] },
        vias,
        clearance,
      ) &&
      changedFanoutCopperIsSelfClear(candidate, segments, clearance, changed)
    )
  }
  if (
    !audit(
      rawSegments,
      new Set(rawSegments.slice(first).map((_, i) => first + i)),
    )
  )
    return false
  const start = rawSegments[first]!
  const incoming = rawSegments[first - 1]
  let cut = start.start
  if (incoming?.layer === start.layer && distance(incoming.end, cut) < 1e-8) {
    // The route converter merges collinear grid steps before normalization.
    // Measure that full incoming run: a short last grid step can disappear
    // entirely inside the join chamfer of the merged run.
    let runStart = incoming.start
    for (let index = first - 2; index >= 0; index--) {
      const previous = rawSegments[index]!
      if (
        previous.layer !== incoming.layer ||
        distance(previous.end, runStart) > 1e-8
      )
        break
      const ux = runStart.x - previous.start.x,
        uy = runStart.y - previous.start.y,
        vx = cut.x - runStart.x,
        vy = cut.y - runStart.y
      if (Math.abs(ux * vy - uy * vx) >= 1e-10 || ux * vx + uy * vy < 0) break
      runStart = previous.start
    }
    const length = distance(runStart, cut)
    if (length < 1e-10) return false
    // The far end can consume at most another third of the incoming run.
    // This cut therefore remains on unchanged copper in the final path.
    const trim = Math.min(maximumJoinLength, length / 3)
    cut = {
      x: cut.x + ((runStart.x - cut.x) * trim) / length,
      y: cut.y + ((runStart.y - cut.y) * trim) / length,
    }
  }
  const suffix = terminalSuffixAt(plan.segments, cut, start.layer)
  return !!suffix && audit(suffix.segments, suffix.changed, plan.segments)
}

/** Only replace a short, contiguous tail on its existing terminal layer. */
function* terminalEntryRepairs(params: {
  splice: BoundaryTerminalSplice
  connector: BoundaryTerminalConnector
  clearance: number
}): Generator<{
  replacement: RoutedSegment[]
  firstEntrySegmentIndex: number
}> {
  const { splice, connector, clearance } = params
  const originalFirst = splice.firstEntrySegmentIndex
  const first = splice.rawSegments[originalFirst]
  if (!first || first.layer !== connector.layer) return
  const maximumTailLength = 4 * (first.width + clearance)
  let tailLength = 0
  for (let cut = originalFirst; cut >= Math.max(0, originalFirst - 16); cut--) {
    const segment = splice.rawSegments[cut]!
    // Preserve all layer transitions and their original physical barrels.
    if (
      segment.layer !== connector.layer ||
      (cut < originalFirst &&
        distance(segment.end, splice.rawSegments[cut + 1]!.start) > 1e-7)
    )
      break
    if (cut < originalFirst) tailLength += distance(segment.start, segment.end)
    if (tailLength > maximumTailLength + 1e-7) break
    const start = segment.start,
      { goal, exit, edge } = connector
    const horizontal = edge === "left" || edge === "right"
    const sign = edge === "left" || edge === "bottom" ? -1 : 1
    const normal = sign * (horizontal ? goal.x - start.x : goal.y - start.y)
    const transverse = Math.abs(
      horizontal ? goal.y - start.y : goal.x - start.x,
    )
    // The original emitted ordering already failed. Earlier cuts can remove
    // a short returning arm and make that ordering clear without changing vias.
    const entries: Point2D[][] = []
    if (cut < originalFirst) {
      const entry = getBoundaryTerminalEntry(start, connector)
      if (entry) entries.push(entry)
    }
    if (normal >= transverse - 1e-9) {
      const bend = horizontal
        ? { x: goal.x - sign * transverse, y: start.y }
        : { x: start.x, y: goal.y - sign * transverse }
      entries.push([start, bend, goal])
    }
    for (const entry of entries) {
      const points = [...entry, exit].filter(
        (point, index, all) =>
          index === 0 || distance(point, all[index - 1]!) > 1e-10,
      )
      yield {
        replacement: points.slice(1).map((end, index) => ({
          ...segment,
          start: points[index]!,
          end,
        })),
        firstEntrySegmentIndex: cut,
      }
    }
  }
}

/**
 * Repair the emitted entry's own clearance with the other axis/45 ordering or
 * by replacing at most four pitches of its final grid walk. Search occupancy
 * stays unchanged; check every replacement against all retained copper before
 * the caller normalizes and validates the complete bus.
 */
export function repairBoundaryTerminalEntries(params: {
  plans: readonly FanoutRoutePlan[]
  splices: ReadonlyMap<string, BoundaryTerminalSplice>
  connectors: ReadonlyMap<string, BoundaryTerminalConnector>
  clearance: number
  segmentIsClear: (segment: RoutedSegment, connectionName: string) => boolean
}): {
  plans: FanoutRoutePlan[]
  splices: Map<string, BoundaryTerminalSplice>
} | null {
  const plans = [...params.plans],
    splices = new Map(params.splices)
  for (const [index, plan] of plans.entries()) {
    const connector = params.connectors.get(plan.connectionName)
    if (!connector) continue
    const splice = splices.get(plan.connectionName)
    if (!splice) return null
    if (
      boundaryTerminalPlanIsSelfClear({
        plan,
        splice,
        maximumJoinLength: 0,
        clearance: params.clearance,
      })
    )
      continue
    const foreign = plans.filter(
      (other) => other.connectionIndex !== plan.connectionIndex,
    )
    let repaired = false
    for (const { replacement, firstEntrySegmentIndex } of terminalEntryRepairs({
      splice,
      connector,
      clearance: params.clearance,
    })) {
      const first = replacement[0]!
      const current = terminalSuffixAt(plan.segments, first.start, first.layer)
      if (!current) continue
      const firstChanged = Math.min(...current.changed)
      const segments = [
        ...current.segments.slice(0, firstChanged),
        ...replacement,
      ]
      const candidate = createPlanWithSegments(plan, segments)
      if (!candidate) continue
      const nextSplice = {
        rawSegments: [
          ...splice.rawSegments.slice(0, firstEntrySegmentIndex),
          ...replacement,
        ],
        firstEntrySegmentIndex,
      }
      if (
        !boundaryTerminalPlanIsSelfClear({
          plan: candidate,
          splice: nextSplice,
          maximumJoinLength: 0,
          clearance: params.clearance,
        })
      )
        continue
      if (
        replacement.some(
          (segment) =>
            !params.segmentIsClear(segment, plan.connectionName) ||
            foreign.some(
              (other) =>
                [
                  ...other.segments,
                  ...(other.planeEndpointSegments ?? []),
                ].some(
                  (s) => !segmentsAreClear(segment, s, params.clearance),
                ) ||
                [
                  other.via,
                  ...(other.additionalVias ?? []),
                  other.planeEndpointVia,
                ]
                  .filter((v) => !!v)
                  .some(
                    (v) =>
                      v.spanLayers.includes(segment.layer) &&
                      distancePointToSegment(
                        v.center,
                        segment.start,
                        segment.end,
                      ) <
                        (v.diameter + segment.width) / 2 +
                          params.clearance -
                          1e-9,
                  ),
            ),
        )
      )
        continue
      plans[index] = candidate
      splices.set(plan.connectionName, nextSplice)
      repaired = true
      break
    }
    if (!repaired) return null
  }
  return { plans, splices }
}

/**
 * Add directed two-hop links only. The caller must restrict each added edge to
 * its active terminal/layer and check every emitted entry segment dynamically.
 */
export function addBoundaryTerminalNeighbors(params: {
  grid: NeighborGrid
  terminals: readonly { connector: BoundaryTerminalConnector; cellId: number }[]
  segmentIsClear: (
    a: Point2D,
    b: Point2D,
    connector: BoundaryTerminalConnector,
  ) => boolean
  margin: number
}): Pick<NeighborGrid, "neighborOffset" | "neighborIds" | "neighborCosts"> & {
  extendedEdges: ReadonlySet<string>
  regions: readonly TerminalConnectorRegion[]
} {
  const { grid } = params
  if (!Number.isFinite(params.margin) || params.margin < 0)
    throw new Error("Terminal connector margin must be finite and non-negative")
  const pointAt = (cell: number): Point2D => ({
    x: grid.cellCenterX[cell]!,
    y: grid.cellCenterY[cell]!,
  })
  const additions = new Map<number, Set<number>>()
  const extendedEdges = new Set<string>()
  const regionsByEdge = new Map<FanoutEdge, TerminalConnectorRegion>()
  for (const { connector, cellId: end } of params.terminals) {
    if (!Number.isInteger(end) || end < 0 || end >= grid.planeSize)
      throw new Error("Invalid native terminal cell")
    const candidates = new Set<number>([end])
    for (
      let i = grid.neighborOffset[end]!;
      i < grid.neighborOffset[end + 1]!;
      i++
    ) {
      const middle = grid.neighborIds[i]!
      candidates.add(middle)
      for (
        let j = grid.neighborOffset[middle]!;
        j < grid.neighborOffset[middle + 1]!;
        j++
      )
        candidates.add(grid.neighborIds[j]!)
    }
    // Include every possible original/added entry, not just currently clear
    // links. Physical rule values and clipped cells determine this region.
    const points = [
      connector.exit,
      connector.goal,
      ...[...candidates].map(pointAt),
    ]
    const region = {
      minX: Math.min(...points.map((p) => p.x)) - params.margin,
      maxX: Math.max(...points.map((p) => p.x)) + params.margin,
      minY: Math.min(...points.map((p) => p.y)) - params.margin,
      maxY: Math.max(...points.map((p) => p.y)) + params.margin,
    }
    const previousRegion = regionsByEdge.get(connector.edge)
    regionsByEdge.set(
      connector.edge,
      previousRegion
        ? {
            minX: Math.min(previousRegion.minX, region.minX),
            maxX: Math.max(previousRegion.maxX, region.maxX),
            minY: Math.min(previousRegion.minY, region.minY),
            maxY: Math.max(previousRegion.maxY, region.maxY),
          }
        : region,
    )
    for (const cell of candidates) {
      if (cell === end) continue
      let existing = false
      for (
        let i = grid.neighborOffset[cell]!;
        i < grid.neighborOffset[cell + 1]!;
        i++
      )
        if (grid.neighborIds[i] === end) existing = true
      if (existing) continue
      const entry = getBoundaryTerminalEntry(pointAt(cell), connector)
      if (
        !entry ||
        entry
          .slice(1)
          .some((p, i) => !params.segmentIsClear(entry[i]!, p, connector))
      )
        continue
      const links = additions.get(cell) ?? new Set<number>()
      links.add(end)
      additions.set(cell, links)
      extendedEdges.add(`${cell}:${end}`)
    }
  }
  const offsets = new Int32Array(grid.planeSize + 1)
  const ids: number[] = []
  const costs: number[] = []
  for (let cell = 0; cell < grid.planeSize; cell++) {
    offsets[cell] = ids.length
    for (
      let i = grid.neighborOffset[cell]!;
      i < grid.neighborOffset[cell + 1]!;
      i++
    ) {
      ids.push(grid.neighborIds[i]!)
      costs.push(grid.neighborCosts[i]!)
    }
    for (const end of additions.get(cell) ?? []) {
      ids.push(end)
      costs.push(distance(pointAt(cell), pointAt(end)))
    }
  }
  offsets[grid.planeSize] = ids.length
  return {
    neighborOffset: offsets,
    neighborIds: Int32Array.from(ids),
    neighborCosts: Float32Array.from(costs),
    extendedEdges,
    regions: [...regionsByEdge.values()],
  }
}

export type TerminalCopperPoint = Point2D & { z: number }
export interface TerminalCopperRoute {
  connectionName: string
  route: TerminalCopperPoint[]
  vias: Point2D[]
}

/** Restore the exact public exit without relocating an end-cell through via. */
export function appendBoundaryTerminalApproach(
  route: TerminalCopperRoute,
  connector: BoundaryTerminalConnector,
  endCellCenter: Point2D,
): TerminalCopperRoute {
  const a = route.route.at(-2)
  const b = route.route.at(-1)
  if (!a || !b || distance(b, connector.goal) > 1e-7)
    throw new Error("Native terminal route does not end at its reserved goal")
  let prefix = route.route.slice(0, -2)
  let start: TerminalCopperPoint = a
  if (a.z !== b.z) {
    // Native output replaces its last grid state with the off-grid port. The
    // actual barrel remains at the grid center on BOTH layers.
    if (distance(a, endCellCenter) > 1e-7)
      throw new Error("Native terminal via has a noncoincident departure")
    prefix = [...prefix, a]
    start = { ...endCellCenter, z: b.z }
  }
  const entry = getBoundaryTerminalEntry(start, connector)
  if (!entry)
    throw new Error("Native terminal route has no perpendicular entry")
  return {
    ...route,
    route: [
      ...prefix,
      ...entry.map((p) => ({ ...p, z: b.z })),
      { ...connector.exit, z: b.z },
    ],
  }
}

type DynamicCopper =
  | {
      kind: "segment"
      owner: string
      a: TerminalCopperPoint
      b: TerminalCopperPoint
    }
  | { kind: "via"; owner: string; center: Point2D }

/**
 * Exact negotiated copper near terminal entries. Native cell occupancy alone
 * does not describe a bend between cells. Invalidate after BOTH finalization
 * and ripping; owners are returned to the caller's existing native rip chain.
 */
export class BoundaryTerminalCopper {
  private dirty = true
  private buckets = new Map<string, Set<DynamicCopper>>()
  private readonly cellSize: number
  private readonly padding: number
  constructor(
    private params: {
      regions: readonly TerminalConnectorRegion[]
      traceWidth: number
      clearance: number
      viaDiameter: number
      getRoutes: () => readonly TerminalCopperRoute[]
    },
  ) {
    this.padding =
      Math.max(params.traceWidth, params.viaDiameter) + params.clearance
    this.cellSize = Math.max(
      params.traceWidth + params.clearance,
      params.viaDiameter,
    )
  }

  invalidate(): void {
    this.dirty = true
  }

  private intersects(a: Point2D, b = a): boolean {
    return intersectsRegion(this.params.regions, a, b)
  }

  private cells(
    a: Point2D,
    b: Point2D,
    padding: number,
    visit: (key: string) => void,
  ): void {
    for (
      let x = Math.floor((Math.min(a.x, b.x) - padding) / this.cellSize);
      x <= Math.floor((Math.max(a.x, b.x) + padding) / this.cellSize);
      x++
    )
      for (
        let y = Math.floor((Math.min(a.y, b.y) - padding) / this.cellSize);
        y <= Math.floor((Math.max(a.y, b.y) + padding) / this.cellSize);
        y++
      )
        visit(`${x},${y}`)
  }

  private refresh(): void {
    if (!this.dirty) return
    this.buckets.clear()
    const add = (copper: DynamicCopper, a: Point2D, b = a) => {
      if (!this.intersects(a, b)) return
      this.cells(a, b, this.padding, (key) => {
        const bucket = this.buckets.get(key) ?? new Set<DynamicCopper>()
        bucket.add(copper)
        this.buckets.set(key, bucket)
      })
    }
    for (const route of this.params.getRoutes()) {
      for (let i = 1; i < route.route.length; i++) {
        const a = route.route[i - 1]!
        const b = route.route[i]!
        if (a.z === b.z)
          add({ kind: "segment", owner: route.connectionName, a, b }, a, b)
      }
      for (const center of route.vias)
        add({ kind: "via", owner: route.connectionName, center }, center)
    }
    this.dirty = false
  }

  private nearby(a: Point2D, b = a): Set<DynamicCopper> {
    this.refresh()
    const found = new Set<DynamicCopper>()
    this.cells(a, b, 0, (key) => {
      for (const copper of this.buckets.get(key) ?? []) found.add(copper)
    })
    return found
  }

  blockingSegmentOwners(
    owner: string,
    points: readonly Point2D[],
    z: number,
  ): Set<string> {
    const found = new Set<string>()
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!
      const b = points[i]!
      if (!this.intersects(a, b)) continue
      for (const copper of this.nearby(a, b)) {
        if (copper.owner === owner) continue
        const separation =
          copper.kind === "via"
            ? distancePointToSegment(copper.center, a, b)
            : copper.a.z === z
              ? distanceSegmentToSegment(a, b, copper.a, copper.b)
              : Infinity
        const required =
          (this.params.traceWidth +
            (copper.kind === "via"
              ? this.params.viaDiameter
              : this.params.traceWidth)) /
            2 +
          this.params.clearance
        if (separation < required - 1e-9) found.add(copper.owner)
      }
    }
    return found
  }

  /** Always query the actual cell-center barrel, even for a zero-length entry. */
  blockingViaOwners(owner: string, center: Point2D): Set<string> {
    const found = new Set<string>()
    if (!this.intersects(center)) return found
    for (const copper of this.nearby(center)) {
      if (copper.owner === owner) continue
      const separation =
        copper.kind === "via"
          ? distance(center, copper.center)
          : distancePointToSegment(center, copper.a, copper.b)
      const required =
        (this.params.viaDiameter +
          (copper.kind === "via"
            ? this.params.viaDiameter
            : this.params.traceWidth)) /
          2 +
        this.params.clearance
      if (separation < required - 1e-9) found.add(copper.owner)
    }
    return found
  }
}
