import { expect } from "bun:test"
import type { SimplifiedPcbTrace } from "@tscircuit/capacity-autorouter"

/** Inspect emitted SRJ wires independently of the solver's plan metadata. */
export function expectStraightOr45Fanout(
  traces: readonly SimplifiedPcbTrace[],
) {
  for (const trace of traces) {
    let previousWire:
      | Extract<SimplifiedPcbTrace["route"][number], { route_type: "wire" }>
      | undefined
    let previousDirection: { x: number; y: number } | undefined
    for (const point of trace.route) {
      if (point.route_type !== "wire") {
        previousWire = undefined
        previousDirection = undefined
        continue
      }
      if (previousWire?.layer === point.layer) {
        const dx = point.x - previousWire.x,
          dy = point.y - previousWire.y,
          length = Math.hypot(dx, dy)
        if (length > 1e-9) {
          expect(
            Math.min(
              Math.abs(dx),
              Math.abs(dy),
              Math.abs(Math.abs(dx) - Math.abs(dy)),
            ),
          ).toBeLessThan(1e-7)
          const direction = { x: dx / length, y: dy / length }
          if (previousDirection)
            expect(
              previousDirection.x * direction.x +
                previousDirection.y * direction.y,
            ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
          previousDirection = direction
        }
      } else previousDirection = undefined
      previousWire = point
    }
  }
}
