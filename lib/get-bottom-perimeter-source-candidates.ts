import { distance, distanceSegmentToSegment } from "./geometry"
import { getComponentDogboneViaSiteCandidates } from "./match-component-dogbone-via-sites"
import type { RouteBusParams } from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import { chamferSplitPerimeter } from "./route-split-perimeter-source-escapes"
import type { Bounds, Point2D, PreparedConnection } from "./types"

export interface BottomPerimeterSourceCandidateParams
  extends Pick<
    RouteBusParams,
    | "srj"
    | "bus"
    | "traceWidth"
    | "clearance"
    | "viaDiameter"
    | "viaHoleDiameter"
  > {
  connection: PreparedConnection
  sourceEscape: PeripheralSourceEscape
  sourceBoundary: Bounds
  maximumCandidates?: number
}

/** Propose source copper only. Callers must check complete copper, rematch
 * eligible plane sites, and retain the already routed prefix before accepting.
 * All dimensions and target positions come from the original prepared input. */
export function* getBottomPerimeterSourceCandidates(
  params: BottomPerimeterSourceCandidateParams,
): Generator<PeripheralSourceEscape, void, void> {
  const {
    bus,
    connection,
    sourceEscape,
    sourceBoundary,
    traceWidth,
    viaDiameter,
    clearance,
  } = params
  const limit = params.maximumCandidates ?? 128
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw Error(
      "Perimeter source candidates require a finite nonnegative budget",
    )
  if (bus.exitEdge !== "bottom" || !limit) return
  if (
    connection.connectionIndex !== sourceEscape.connectionIndex ||
    !bus.connections.includes(connection)
  )
    throw Error(
      "Perimeter source candidate does not belong to its prepared bus",
    )
  const q = connection.sourcePoint
  const targetX = (connection.exitTargetPoint ?? connection.targetPoint).x
  const viaPitch = viaDiameter + clearance + 1e-5
  const native = getComponentDogboneViaSiteCandidates(
    [{ ...bus, connections: [connection] }],
    {
      ...params,
      additionalObstacles: params.srj.obstacles,
    },
  ).map((site) => site.point)
  const roofs = [sourceBoundary.maxY, sourceBoundary.maxY + viaPitch]
  const seen = new Set<string>()
  let count = 0
  function candidate(points: Point2D[]): PeripheralSourceEscape | null {
    const path = chamferSplitPerimeter(points, traceWidth)
    const viaPoint = path.at(-1)
    if (!viaPoint || path.length < 2) return null
    const bounds = bus.sharedBoundary
    const radius = viaDiameter / 2
    if (
      viaPoint.x < bounds.minX + radius ||
      viaPoint.x > bounds.maxX - radius ||
      viaPoint.y < bounds.minY + radius ||
      viaPoint.y > bounds.maxY - radius
    )
      return null
    if (
      path.some(
        (point) =>
          point.x < bounds.minX + traceWidth / 2 ||
          point.x > bounds.maxX - traceWidth / 2 ||
          point.y < bounds.minY + traceWidth / 2 ||
          point.y > bounds.maxY - traceWidth / 2,
      )
    )
      return null
    const segments = path.slice(1).map((end, index) => ({
      start: path[index]!,
      end,
      width: traceWidth,
      layer: connection.sourceLayer,
    }))
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!
      const dx = s.end.x - s.start.x
      const dy = s.end.y - s.start.y
      const length = Math.hypot(dx, dy)
      if (
        length < 1e-9 ||
        Math.min(
          Math.abs(dx),
          Math.abs(dy),
          Math.abs(Math.abs(dx) - Math.abs(dy)),
        ) > 1e-7
      )
        return null
      if (i) {
        const p = segments[i - 1]!
        const previousLength = distance(p.start, p.end)
        if (
          (dx * (p.end.x - p.start.x) + dy * (p.end.y - p.start.y)) /
            length /
            previousLength <
          Math.SQRT1_2 - 1e-7
        )
          return null
      }
      for (let j = 0; j < i - 1; j++) {
        const other = segments[j]!
        if (
          distanceSegmentToSegment(s.start, s.end, other.start, other.end) <
          1e-8
        )
          return null
      }
    }
    const key = JSON.stringify(path)
    if (seen.has(key)) return null
    seen.add(key)
    return {
      ...sourceEscape,
      segments,
      via: { ...sourceEscape.via, center: viaPoint },
    }
  }
  // Keep the original four-column search in exactly its previous order. The
  // expanded search is appended so established successful routes are stable.
  const basePaths: Point2D[][] = []
  function* paths(outerColumns: boolean): Generator<Point2D[]> {
    const firstTier = outerColumns ? 4 : 0
    const lastTier = (side: number) =>
      outerColumns
        ? Math.floor(
            (side < 0
              ? sourceBoundary.minX - bus.sharedBoundary.minX - traceWidth / 2
              : bus.sharedBoundary.maxX -
                sourceBoundary.maxX -
                traceWidth / 2) / viaPitch,
          )
        : 3
    // A direct rise avoids an adjacent native interstice at an exposed pad.
    for (const roof of roofs)
      for (const side of [-1, 1])
        for (let tier = firstTier; tier <= lastTier(side); tier++)
          for (let row = 1; row <= 5; row++) {
            const column =
              (side < 0 ? sourceBoundary.minX : sourceBoundary.maxX) +
              side * tier * viaPitch
            const y = sourceBoundary.minY - row * viaPitch
            yield [
              q,
              { x: q.x, y: roof },
              { x: column, y: roof },
              { x: column, y },
              { x: targetX, y },
            ]
          }
    // Interior pads can reach the rail through a legal native junction.
    for (const junction of native)
      for (const side of [-1, 1])
        for (let tier = firstTier; tier <= lastTier(side); tier++)
          for (let row = 1; row <= 5; row++) {
            if (Math.sign(junction.x - q.x) !== side) continue
            const column =
              (side < 0 ? sourceBoundary.minX : sourceBoundary.maxX) +
              side * tier * viaPitch
            const y = sourceBoundary.minY - row * viaPitch
            yield [
              q,
              junction,
              { x: column, y: junction.y },
              { x: column, y },
              { x: targetX, y },
            ]
          }
  }
  for (const outerColumns of [false, true])
    for (const points of paths(outerColumns)) {
      basePaths.push(points)
      const value = candidate(points)
      if (value) {
        yield value
        if (++count >= limit) return
      }
    }
  // A through-via can conflict with a nearby inner-layer tail even when the
  // source rail is clear. The first via need not share the projected exit X.
  // Move only that endpoint by one via pitch; retain the original target and
  // let the caller verify the complete continuation before accepting it.
  for (const points of basePaths)
    for (const offset of [-viaPitch, viaPitch]) {
      const value = candidate([
        ...points.slice(0, -1),
        { ...points.at(-1)!, x: targetX + offset },
      ])
      if (value) {
        yield value
        if (++count >= limit) return
      }
    }
}
