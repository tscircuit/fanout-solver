import type {
  Circle,
  GraphicsObject,
  Line,
  Point,
  Polygon,
  Rect,
  Text,
} from "graphics-debug"
import type { Bounds } from "./types"

type Point2D = { x: number; y: number }

const contains = (bounds: Bounds, point: Point2D): boolean =>
  point.x >= bounds.minX &&
  point.x <= bounds.maxX &&
  point.y >= bounds.minY &&
  point.y <= bounds.maxY

const boxIntersects = (
  bounds: Bounds,
  center: Point2D,
  halfWidth: number,
  halfHeight: number,
): boolean =>
  center.x + halfWidth >= bounds.minX &&
  center.x - halfWidth <= bounds.maxX &&
  center.y + halfHeight >= bounds.minY &&
  center.y - halfHeight <= bounds.maxY

/** Liang-Barsky clip of one segment; returns undefined when it lies outside. */
function clipSegment(
  bounds: Bounds,
  start: Point2D,
  end: Point2D,
): [Point2D, Point2D] | undefined {
  const dx = end.x - start.x
  const dy = end.y - start.y
  let enter = 0
  let leave = 1
  for (const [direction, distance] of [
    [-dx, start.x - bounds.minX],
    [dx, bounds.maxX - start.x],
    [-dy, start.y - bounds.minY],
    [dy, bounds.maxY - start.y],
  ] as const) {
    if (direction === 0) {
      if (distance < 0) return undefined
      continue
    }
    const ratio = distance / direction
    if (direction < 0) enter = Math.max(enter, ratio)
    else leave = Math.min(leave, ratio)
    if (enter > leave) return undefined
  }
  return [
    { x: start.x + dx * enter, y: start.y + dy * enter },
    { x: start.x + dx * leave, y: start.y + dy * leave },
  ]
}

function clipLine(bounds: Bounds, line: Line): Line[] {
  const clipped: Line[] = []
  let run: Point2D[] = []
  const flush = () => {
    if (run.length >= 2) clipped.push({ ...line, points: run })
    run = []
  }
  for (let index = 0; index < line.points.length - 1; index++) {
    const segment = clipSegment(
      bounds,
      line.points[index]!,
      line.points[index + 1]!,
    )
    if (!segment) {
      flush()
      continue
    }
    const [start, end] = segment
    const previous = run.at(-1)
    if (
      !previous ||
      Math.abs(previous.x - start.x) > 1e-9 ||
      Math.abs(previous.y - start.y) > 1e-9
    ) {
      flush()
      run.push(start)
    }
    run.push(end)
  }
  flush()
  return clipped
}

/**
 * Keep only the graphics that lie inside `bounds` (board-space mm, +X right,
 * +Y up). Rectangles and circles that overlap the frame are kept whole, lines
 * are clipped at the frame, and points, texts and arrows are kept when their
 * anchor is inside. The result frames exactly the region of interest instead
 * of every obstacle and endpoint on the board.
 */
export function cropGraphicsToBounds(
  graphics: GraphicsObject,
  bounds: Bounds,
): GraphicsObject {
  const rects = (graphics.rects ?? []).filter((rect: Rect) =>
    boxIntersects(bounds, rect.center, rect.width / 2, rect.height / 2),
  )
  const circles = (graphics.circles ?? []).filter((circle: Circle) =>
    boxIntersects(bounds, circle.center, circle.radius, circle.radius),
  )
  const lines = (graphics.lines ?? []).flatMap((line: Line) =>
    clipLine(bounds, line),
  )
  const points = (graphics.points ?? []).filter((point: Point) =>
    contains(bounds, point),
  )
  const texts = (graphics.texts ?? []).filter((text: Text) =>
    contains(bounds, text),
  )
  const polygons = (graphics.polygons ?? []).filter((polygon: Polygon) =>
    polygon.points.some((point) => contains(bounds, point)),
  )
  const arrows = (graphics.arrows ?? []).filter(
    (arrow) => contains(bounds, arrow.start) && contains(bounds, arrow.end),
  )
  return {
    ...graphics,
    rects,
    circles,
    lines,
    points,
    texts,
    polygons,
    arrows,
    infiniteLines: undefined,
  }
}

/** Frame around `boundary` grown by `margin` on every side. */
export function expandBounds(boundary: Bounds, margin: number): Bounds {
  return {
    minX: boundary.minX - margin,
    maxX: boundary.maxX + margin,
    minY: boundary.minY - margin,
    maxY: boundary.maxY + margin,
  }
}
