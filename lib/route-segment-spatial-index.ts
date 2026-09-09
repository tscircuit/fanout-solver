import type { Bounds, RoutedSegment, RoutedVia } from "./types"

type Entry = Bounds & { segment: RoutedSegment }
type Node = Bounds & { entries?: Entry[]; left?: Node; right?: Node }

/** Immutable, layer-aware broad phase. Callers retain exact clearance checks. */
export class RouteSegmentSpatialIndex {
  private layers = new Map<string, Node>()

  constructor(segments: readonly RoutedSegment[]) {
    const entries = new Map<string, Entry[]>()
    for (const segment of segments) {
      const radius = segment.width / 2
      const entry = {
        segment,
        minX: Math.min(segment.start.x, segment.end.x) - radius,
        maxX: Math.max(segment.start.x, segment.end.x) + radius,
        minY: Math.min(segment.start.y, segment.end.y) - radius,
        maxY: Math.max(segment.start.y, segment.end.y) + radius,
      }
      const layer = entries.get(segment.layer) ?? []
      layer.push(entry)
      entries.set(segment.layer, layer)
    }
    for (const [layer, values] of entries)
      this.layers.set(layer, this.build(values))
  }

  querySegment(segment: RoutedSegment, clearance: number): RoutedSegment[] {
    const margin = segment.width / 2 + clearance + 1e-8
    return this.query([segment.layer], {
      minX: Math.min(segment.start.x, segment.end.x) - margin,
      maxX: Math.max(segment.start.x, segment.end.x) + margin,
      minY: Math.min(segment.start.y, segment.end.y) - margin,
      maxY: Math.max(segment.start.y, segment.end.y) + margin,
    })
  }

  queryVia(via: RoutedVia, clearance: number): RoutedSegment[] {
    const margin = via.diameter / 2 + clearance + 1e-8
    return this.query(via.spanLayers, {
      minX: via.center.x - margin,
      maxX: via.center.x + margin,
      minY: via.center.y - margin,
      maxY: via.center.y + margin,
    })
  }

  private query(layers: readonly string[], box: Bounds): RoutedSegment[] {
    const result: RoutedSegment[] = []
    const overlaps = (other: Bounds) =>
      !(
        other.minX > box.maxX ||
        other.maxX < box.minX ||
        other.minY > box.maxY ||
        other.maxY < box.minY
      )
    const visit = (node: Node): void => {
      if (!overlaps(node)) return
      if (node.entries) {
        for (const entry of node.entries)
          if (overlaps(entry)) result.push(entry.segment)
      } else {
        visit(node.left!)
        visit(node.right!)
      }
    }
    for (const layer of layers) {
      const node = this.layers.get(layer)
      if (node) visit(node)
    }
    return result
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
