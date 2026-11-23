import type { Obstacle } from "@tscircuit/capacity-autorouter"
import type { Bounds, RoutedSegment, RoutedVia } from "./types"

type Entry = Bounds & { obstacle: Obstacle; order: number }
type Node = Bounds & { entries?: Entry[]; left?: Node; right?: Node }

/** Conservative, layer-aware broad phase; callers retain exact shape checks. */
export class ObstacleSpatialIndex {
  private layers = new Map<string, Node>()
  private pours: { order: number; obstacle: Obstacle }[] = []

  constructor(obstacles: readonly Obstacle[]) {
    const layers = new Map<string, Entry[]>()
    for (const [order, obstacle] of obstacles.entries()) {
      if (obstacle.isCopperPour) this.pours.push({ order, obstacle })
      // This radius contains every rotation and matches the static predicate's
      // existing broad phase. Circular and rotated geometry stays unchanged.
      const radius = (Math.abs(obstacle.width) + Math.abs(obstacle.height)) / 2
      const entry = {
        obstacle,
        order,
        minX: obstacle.center.x - radius,
        maxX: obstacle.center.x + radius,
        minY: obstacle.center.y - radius,
        maxY: obstacle.center.y + radius,
      }
      for (const layer of obstacle.layers) {
        const entries = layers.get(layer) ?? []
        entries.push(entry)
        layers.set(layer, entries)
      }
    }
    for (const [layer, entries] of layers)
      this.layers.set(layer, this.build(entries))
  }

  querySegment(segment: RoutedSegment, clearance: number): Obstacle[] {
    const margin = segment.width / 2 + clearance + 1e-8
    return this.query([segment.layer], {
      minX: Math.min(segment.start.x, segment.end.x) - margin,
      maxX: Math.max(segment.start.x, segment.end.x) + margin,
      minY: Math.min(segment.start.y, segment.end.y) - margin,
      maxY: Math.max(segment.start.y, segment.end.y) + margin,
    })
  }

  queryVia(via: RoutedVia, clearance: number): Obstacle[] {
    const margin = via.diameter / 2 + clearance + 1e-8
    return this.query(via.spanLayers, {
      minX: via.center.x - margin,
      maxX: via.center.x + margin,
      minY: via.center.y - margin,
      maxY: via.center.y + margin,
    })
  }

  private query(layers: readonly string[], box: Bounds): Obstacle[] {
    const result = new Map<number, Obstacle>(
      this.pours.map(({ order, obstacle }) => [order, obstacle]),
    )
    const overlaps = (bounds: Bounds) =>
      !(
        bounds.minX > box.maxX ||
        bounds.maxX < box.minX ||
        bounds.minY > box.maxY ||
        bounds.maxY < box.minY
      )
    const visit = (node: Node): void => {
      if (!overlaps(node)) return
      if (node.entries) {
        for (const entry of node.entries)
          if (overlaps(entry)) result.set(entry.order, entry.obstacle)
      } else {
        visit(node.left!)
        visit(node.right!)
      }
    }
    for (const layer of layers) {
      const root = this.layers.get(layer)
      if (root) visit(root)
    }
    return [...result]
      .sort((a, b) => a[0] - b[0])
      .map(([, obstacle]) => obstacle)
  }

  private build(entries: Entry[]): Node {
    const bounds = entries.reduce<Bounds>(
      (b, e) => ({
        minX: Math.min(b.minX, e.minX),
        maxX: Math.max(b.maxX, e.maxX),
        minY: Math.min(b.minY, e.minY),
        maxY: Math.max(b.maxY, e.maxY),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
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
