import {
  distance,
  distancePointToSegment,
  distanceSegmentToSegment,
} from "./geometry"
import type { Point2D } from "./types"

/** Same-net DRC cannot detect copper that bypasses an earlier part of this route. */
export function sourceOriginRouteIsSelfClear(params: {
  points: readonly (Point2D & { z: number })[]
  topZ: number
  traceWidth: number
  viaDiameter: number
  clearance: number
}): boolean {
  const { points, topZ, traceWidth, viaDiameter, clearance } = params
  const segments: {
    a: Point2D
    b: Point2D
    z: number
    edge: number
    run: number
  }[] = []
  const vias: { center: Point2D; fromZ: number; toZ: number; edge: number }[] =
    []
  let run = 0
  for (let edge = 0; edge + 1 < points.length; edge++) {
    const a = points[edge]!,
      b = points[edge + 1]!
    if (a.z !== b.z) {
      if (distance(a, b) > 1e-7) return false
      vias.push({ center: a, fromZ: a.z, toZ: b.z, edge })
      run++
    } else if (distance(a, b) > 1e-9) segments.push({ a, b, z: a.z, edge, run })
  }
  // Distinct TOP runs are separated by real layer transitions, so they have
  // no contiguous local join to exempt. A return cannot touch the old prefix.
  const top = segments.filter((segment) => segment.z === topZ)
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i]!,
        b = top[j]!
      if (
        a.run !== b.run &&
        distanceSegmentToSegment(a.a, a.b, b.a, b.b) <
          traceWidth + clearance - 1e-9
      )
        return false
    }
  for (let i = 0; i < vias.length; i++) {
    const via = vias[i]!
    for (let j = i + 1; j < vias.length; j++)
      if (
        distance(via.center, vias[j]!.center) <
        viaDiameter + clearance - 1e-9
      )
        return false
    const radius = (viaDiameter + traceWidth) / 2 + clearance
    const incident = new Set<number>()
    // Exempt only the actual incoming/outgoing lead in ordered path space.
    // A nearby returning arm is not incident merely because it touches a via.
    for (const direction of [-1, 1] as const) {
      let point = via.center,
        length = 0
      const z = direction === -1 ? via.fromZ : via.toZ
      for (
        let edge = via.edge + direction;
        edge >= 0 && edge + 1 < points.length;
        edge += direction
      ) {
        const a = points[edge]!,
          b = points[edge + 1]!
        const near = direction === -1 ? b : a,
          far = direction === -1 ? a : b
        if (
          a.z !== z ||
          b.z !== z ||
          distance(point, near) > 1e-7 ||
          length > radius + 1e-7
        )
          break
        incident.add(edge)
        length += distance(near, far)
        point = far
      }
    }
    for (const segment of segments)
      if (
        !incident.has(segment.edge) &&
        distancePointToSegment(via.center, segment.a, segment.b) < radius - 1e-9
      )
        return false
  }
  return true
}
