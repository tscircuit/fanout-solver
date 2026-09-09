import { expect, test } from "bun:test"
import {
  retryLayerReservedRoutingSteps,
  type LayerReservedAttemptState,
} from "lib/retry-layer-reserved-routing"
import type { LayerReservedRoutingProgress } from "lib/route-layer-reserved-buses"
import type { FanoutRoutePlan } from "lib/types"

test("failed wide length matching and downstream narrow groups retry the entire pipeline with fresh reservations", () => {
  const complete: FanoutRoutePlan[] = []
  for (const mode of [
    "success",
    "narrow-lengths",
    "narrow-routing",
    "wide-lengths",
    "routing",
    "fixed",
    "twice",
  ] as const) {
    const states: LayerReservedAttemptState[] = [],
      maps: Map<number, { x: number; y: number }>[] = []
    const initial = new Map([[1, { x: 1, y: 2 }]])
    const generator = retryLayerReservedRoutingSteps(
      mode !== "fixed",
      function* (state) {
        states.push(state)
        // Each complete attempt constructs its source map from the original
        // input. Provisional copper from the failed run cannot leak forward.
        const reservations = new Map(initial)
        maps.push(reservations)
        expect(reservations.get(1)).toEqual({ x: 1, y: 2 })
        reservations.set(1, { x: 20, y: 30 })
        yield {
          phase: "sources",
          routedConnectionCount: 0,
        } as LayerReservedRoutingProgress
        if (mode === "success" || (states.length === 2 && mode !== "twice"))
          return complete
        state.failedNarrowGroup = mode !== "routing" && mode !== "wide-lengths"
        state.failedWideMatching = mode === "wide-lengths"
        return null
      },
    )
    let next = generator.next(),
      yields = 0
    while (!next.done) {
      yields++
      next = generator.next()
    }
    const retries =
      mode === "narrow-lengths" ||
      mode === "narrow-routing" ||
      mode === "wide-lengths" ||
      mode === "twice"
    expect(states).toHaveLength(retries ? 2 : 1)
    expect(yields).toBe(states.length)
    expect(states[0]!.reserveFutureApproaches).toBe(true)
    if (retries) {
      expect(states[1]!.reserveFutureApproaches).toBe(false)
      expect(states[1]).not.toBe(states[0])
      expect(maps[1]).not.toBe(maps[0])
    }
    expect(initial.get(1)).toEqual({ x: 1, y: 2 })
    expect(next.value).toBe(
      mode === "success" ||
        mode === "narrow-lengths" ||
        mode === "narrow-routing" ||
        mode === "wide-lengths"
        ? complete
        : null,
    )
  }
})
