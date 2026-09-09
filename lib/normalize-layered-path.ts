import { distance } from "./geometry"
import type { Point2D } from "./types"

export interface LayeredPathPoint extends Point2D {
  z: number
}

/** Keep exact terminals/vias while replacing grid corners and endpoint links. */
export function normalizeLayeredPath(params: {
  points: readonly LayeredPathPoint[]
  chamfer: number
  segmentIsClear: (start: LayeredPathPoint, end: LayeredPathPoint) => boolean
}): LayeredPathPoint[] | null {
  const { points, chamfer, segmentIsClear } = params
  if (points.length < 2) return null
  const epsilon = 1e-7
  let candidates: LayeredPathPoint[][] = [[points[0]!]]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      dx = b.x - a.x,
      dy = b.y - a.y
    if (
      a.z !== b.z ||
      Math.abs(dx) < epsilon ||
      Math.abs(dy) < epsilon ||
      Math.abs(Math.abs(dx) - Math.abs(dy)) < epsilon
    ) {
      for (const candidate of candidates) candidate.push(b)
      continue
    }
    const diagonal = Math.min(Math.abs(dx), Math.abs(dy))
    const bends = [
      {
        x: a.x + Math.sign(dx) * diagonal,
        y: a.y + Math.sign(dy) * diagonal,
        z: a.z,
      },
      {
        x: b.x - Math.sign(dx) * diagonal,
        y: b.y - Math.sign(dy) * diagonal,
        z: a.z,
      },
      { x: b.x, y: a.y, z: a.z },
      { x: a.x, y: b.y, z: a.z },
    ].filter((bend) => segmentIsClear(a, bend) && segmentIsClear(bend, b))
    candidates = candidates
      .flatMap((candidate) => bends.map((bend) => [...candidate, bend, b]))
      .slice(0, 16)
    if (candidates.length === 0) return null
  }
  for (const candidate of candidates) {
    const result: LayeredPathPoint[] = [candidate[0]!]
    let valid = true
    for (let i = 1; i < candidate.length - 1; i++) {
      const a = candidate[i - 1]!,
        b = candidate[i]!,
        c = candidate[i + 1]!,
        incoming = distance(a, b),
        outgoing = distance(b, c)
      if (
        a.z !== b.z ||
        b.z !== c.z ||
        incoming < epsilon ||
        outgoing < epsilon
      ) {
        result.push(b)
        continue
      }
      const ux = (b.x - a.x) / incoming,
        uy = (b.y - a.y) / incoming,
        vx = (c.x - b.x) / outgoing,
        vy = (c.y - b.y) / outgoing,
        dot = ux * vx + uy * vy
      const reversingDiagonal = Math.abs(dot + Math.SQRT1_2) < epsilon
      if (Math.abs(dot) > epsilon && !reversingDiagonal) {
        result.push(b)
        continue
      }
      let trim = Math.min(chamfer, incoming / 3, outgoing / 3),
        beveled = false
      while (trim >= 1e-6) {
        const before = { x: b.x - ux * trim, y: b.y - uy * trim, z: b.z },
          after = { x: b.x + vx * trim, y: b.y + vy * trim, z: b.z }
        // A 135-degree corner needs two intermediate headings, each 45 degrees
        // from its neighbors. Equal legs of trim * (sqrt(2) - 1) join the cuts.
        const turnSign = Math.sign(ux * vy - uy * vx)
        const middle = reversingDiagonal
          ? {
              x:
                before.x +
                (ux - turnSign * uy) * Math.SQRT1_2 * trim * (Math.SQRT2 - 1),
              y:
                before.y +
                (uy + turnSign * ux) * Math.SQRT1_2 * trim * (Math.SQRT2 - 1),
              z: b.z,
            }
          : undefined
        if (
          middle
            ? segmentIsClear(before, middle) && segmentIsClear(middle, after)
            : segmentIsClear(before, after)
        ) {
          result.push(before, ...(middle ? [middle] : []), after)
          beveled = true
          break
        }
        trim /= 2
      }
      if (!beveled) {
        valid = false
        break
      }
    }
    if (!valid) continue
    result.push(candidate.at(-1)!)
    for (let i = 1; i < result.length; i++) {
      const a = result[i - 1]!,
        b = result[i]!
      if (a.z !== b.z) {
        if (distance(a, b) > epsilon) valid = false
        continue
      }
      if (!segmentIsClear(a, b)) {
        valid = false
        break
      }
      const dx = Math.abs(a.x - b.x),
        dy = Math.abs(a.y - b.y)
      if (dx > epsilon && dy > epsilon && Math.abs(dx - dy) > epsilon) {
        valid = false
        break
      }
      const c = result[i + 1]
      if (
        c?.z === b.z &&
        distance(a, b) > epsilon &&
        distance(b, c) > epsilon
      ) {
        const dot =
          ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
          (distance(a, b) * distance(b, c))
        if (dot < Math.SQRT1_2 - epsilon) {
          valid = false
          break
        }
      }
    }
    if (valid) return result
  }
  return null
}
