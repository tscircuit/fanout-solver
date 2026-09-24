import type { Obstacle } from "@tscircuit/capacity-autorouter"
import type { Bounds, RoutedSegment, RoutedVia } from "./types"

type Entry = Bounds & { obstacle: Obstacle }
type Node = Bounds & { entries?: Entry[]; left?: Node; right?: Node }
type LayerName = RoutedSegment["layer"]

interface ObstacleQueryContext {
  bounds: Bounds
  matches: Set<Obstacle>
}

function boundsOverlap(bounds: Bounds, other: Bounds): boolean {
  return !(
    other.minX > bounds.maxX ||
    other.maxX < bounds.minX ||
    other.minY > bounds.maxY ||
    other.maxY < bounds.minY
  )
}

function collectOverlappingObstacles(
  node: Node,
  ctx: ObstacleQueryContext,
): void {
  if (!boundsOverlap(ctx.bounds, node)) return
  if (node.entries) {
    for (const entry of node.entries)
      if (boundsOverlap(ctx.bounds, entry)) ctx.matches.add(entry.obstacle)
  } else {
    collectOverlappingObstacles(node.left!, ctx)
    collectOverlappingObstacles(node.right!, ctx)
  }
}

/** Immutable broad phase; exact shape and electrical exemptions remain with callers. */
export class ObstacleSpatialIndex {
  private readonly layers = new Map<LayerName, Node>()

  constructor(obstacles: readonly Obstacle[]) {
    const byLayer = new Map<LayerName, Obstacle[]>()
    for (const obstacle of obstacles)
      for (const layer of new Set(obstacle.layers)) {
        const entries = byLayer.get(layer) ?? []
        entries.push(obstacle)
        byLayer.set(layer, entries)
      }
    for (const [layer, entries] of byLayer) {
      const bounds: Entry[] = []
      for (const obstacle of entries) {
        const shape = obstacle as Obstacle & {
          shape?: string
          ccwRotationDegrees?: number
        }
        const ccwRotationRadians =
          ((shape.ccwRotationDegrees ?? 0) * Math.PI) / 180
        const cos = Math.abs(Math.cos(ccwRotationRadians)),
          sin = Math.abs(Math.sin(ccwRotationRadians))
        // Circular geometry uses width as its diameter, including when height differs.
        const halfWidth =
          shape.shape === "circle"
            ? obstacle.width / 2
            : (cos * obstacle.width + sin * obstacle.height) / 2
        const halfHeight =
          shape.shape === "circle"
            ? obstacle.width / 2
            : (sin * obstacle.width + cos * obstacle.height) / 2
        bounds.push({
          obstacle,
          minX: obstacle.center.x - halfWidth,
          minY: obstacle.center.y - halfHeight,
          maxX: obstacle.center.x + halfWidth,
          maxY: obstacle.center.y + halfHeight,
        })
      }
      this.layers.set(layer, this.build(bounds))
    }
  }

  querySegment(segment: RoutedSegment, clearance: number): Obstacle[] {
    const margin = segment.width / 2 + clearance + 1e-8
    return this.query([segment.layer], {
      minX: Math.min(segment.start.x, segment.end.x) - margin,
      minY: Math.min(segment.start.y, segment.end.y) - margin,
      maxX: Math.max(segment.start.x, segment.end.x) + margin,
      maxY: Math.max(segment.start.y, segment.end.y) + margin,
    })
  }

  queryVia(via: RoutedVia, clearance: number): Obstacle[] {
    const margin = via.diameter / 2 + clearance + 1e-8
    return this.query(via.spanLayers, {
      minX: via.center.x - margin,
      minY: via.center.y - margin,
      maxX: via.center.x + margin,
      maxY: via.center.y + margin,
    })
  }

  private query(layers: readonly LayerName[], bounds: Bounds): Obstacle[] {
    const matches = new Set<Obstacle>()
    const ctx: ObstacleQueryContext = { bounds, matches }
    for (const layer of layers) {
      const root = this.layers.get(layer)
      if (root) collectOverlappingObstacles(root, ctx)
    }
    return [...matches]
  }

  private build(entries: Entry[]): Node {
    const bounds = entries.reduce<Bounds>(
      (bounds, entry) => ({
        minX: Math.min(bounds.minX, entry.minX),
        minY: Math.min(bounds.minY, entry.minY),
        maxX: Math.max(bounds.maxX, entry.maxX),
        maxY: Math.max(bounds.maxY, entry.maxY),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    )
    if (entries.length <= 8) return { ...bounds, entries }
    const horizontal = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY
    entries.sort((a, b) =>
      horizontal
        ? a.minX + a.maxX - b.minX - b.maxX
        : a.minY + a.maxY - b.minY - b.maxY,
    )
    const middle = Math.floor(entries.length / 2)
    return {
      ...bounds,
      left: this.build(entries.slice(0, middle)),
      right: this.build(entries.slice(middle)),
    }
  }
}
