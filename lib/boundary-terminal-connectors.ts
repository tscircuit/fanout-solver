import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import { addedTuningViasAreSelfClear } from "./match-bus-lengths"
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

/** Check the new entry against its own retained path and every physical hole. */
export function boundaryTerminalPlanIsSelfClear(params: {
  plan: FanoutRoutePlan
  retainedSegments: readonly RoutedSegment[]
  regions: readonly TerminalConnectorRegion[]
  clearance: number
}): boolean {
  const terminalVias = [params.plan.via, ...(params.plan.additionalVias ?? [])]
    .filter((via) => !!via)
    .filter((via) => intersectsRegion(params.regions, via.center))
  if (!addedTuningViasAreSelfClear(params.plan, terminalVias, params.clearance))
    return false
  return changedFanoutCopperIsSelfClear(
    {
      ...params.plan,
      // An entry that retraces a nonadjacent old arm is still a physical short.
      // Force the whole connector region through the connected-body checks,
      // even if a new segment happens to overlap an old straight segment.
      segments: params.retainedSegments.filter(
        (segment) =>
          !intersectsRegion(params.regions, segment.start, segment.end),
      ),
    },
    params.plan.segments,
    params.clearance,
  )
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
