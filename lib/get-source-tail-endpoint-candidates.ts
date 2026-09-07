import { distance } from "./geometry"
import type { RouteBusParams } from "./route-bus"
import type { PeripheralSourceEscape } from "./route-peripheral-source-escapes"
import type { PreparedConnection } from "./types"

export interface SourceTailEndpointCandidateParams
  extends Pick<RouteBusParams, "bus" | "traceWidth" | "clearance"> {
  connection: PreparedConnection
  sourceEscape: PeripheralSourceEscape
  maximumSteps?: number
}

/** Slide an unfinished source's first via along its existing final straight
 * segment. These are geometry candidates only; callers must check every source
 * and accepted route, then complete the original terminal before committing. */
export function* getSourceTailEndpointCandidates(
  params: SourceTailEndpointCandidateParams,
): Generator<PeripheralSourceEscape, void, void> {
  const { bus, connection, sourceEscape, traceWidth, clearance } = params
  const maximumSteps = params.maximumSteps ?? 5
  if (
    !Number.isSafeInteger(maximumSteps) ||
    maximumSteps < 0 ||
    maximumSteps > 16
  )
    throw Error("Source endpoint search requires a bounded nonnegative budget")
  if (
    sourceEscape.connectionIndex !== connection.connectionIndex ||
    !bus.connections.includes(connection)
  )
    throw Error("Source endpoint candidates require the original connection")
  const tail = sourceEscape.segments.at(-1)
  if (!tail || distance(tail.end, sourceEscape.via.center) > 1e-7)
    throw Error("Source endpoint candidates require a coherent first via")
  // A native one-segment dogbone is assigned by the native-site matcher.
  if (sourceEscape.segments.length < 2) return
  const dx = tail.end.x - tail.start.x
  const dy = tail.end.y - tail.start.y
  const length = Math.hypot(dx, dy)
  if (
    length < 1e-7 ||
    Math.min(
      Math.abs(dx),
      Math.abs(dy),
      Math.abs(Math.abs(dx) - Math.abs(dy)),
    ) > 1e-7
  )
    throw Error("Source endpoint search requires a straight or diagonal tail")
  const pitch = sourceEscape.via.diameter + clearance + 1e-5
  const radius = sourceEscape.via.diameter / 2
  const bounds = bus.sharedBoundary
  for (let step = 1; step <= maximumSteps; step++) {
    for (const sign of [-1, 1]) {
      const offset = sign * step * pitch
      if (length + offset < traceWidth) continue
      const center = {
        x: tail.end.x + (dx / length) * offset,
        y: tail.end.y + (dy / length) * offset,
      }
      if (
        center.x < bounds.minX + radius ||
        center.x > bounds.maxX - radius ||
        center.y < bounds.minY + radius ||
        center.y > bounds.maxY - radius
      )
        continue
      yield {
        ...sourceEscape,
        segments: [
          ...sourceEscape.segments.slice(0, -1),
          { ...tail, end: center },
        ],
        via: { ...sourceEscape.via, center },
      }
    }
  }
}
