import { expect, test } from "bun:test"
import { shouldUseAdaptiveDensePlaneRouting } from "../lib/should-use-adaptive-dense-plane-routing"
import type { Bounds, FanoutEdge, Point2D, PreparedBus } from "../lib/types"

const clockwiseEdge: Record<FanoutEdge, FanoutEdge> = {
  left: "top",
  top: "right",
  right: "bottom",
  bottom: "left",
}

const rotateEdge = (edge: FanoutEdge, turns: number): FanoutEdge => {
  let rotated = edge
  for (let turn = 0; turn < turns; turn++) rotated = clockwiseEdge[rotated]
  return rotated
}

function createMemoryField(params: {
  sourceEdge: FanoutEdge
  exitEdge: FanoutEdge
}): PreparedBus[] {
  const componentBounds: Bounds = { minX: -6, maxX: 6, minY: -6, maxY: 6 }
  const sourcePointsByEdge: Record<FanoutEdge, Point2D[]> = {
    left: [
      { x: -5, y: -1 },
      { x: -5, y: 0 },
      { x: -5, y: 1 },
    ],
    right: [
      { x: 5, y: -1 },
      { x: 5, y: 0 },
      { x: 5, y: 1 },
    ],
    bottom: [
      { x: -1, y: -5 },
      { x: 0, y: -5 },
      { x: 1, y: -5 },
    ],
    top: [
      { x: -1, y: 5 },
      { x: 0, y: 5 },
      { x: 1, y: 5 },
    ],
  }
  const makeBus = (
    busId: string,
    connectionCount: number,
    termination: PreparedBus["termination"],
  ) =>
    ({
      busId,
      componentBounds,
      componentId: "memory-controller",
      exitEdge: params.exitEdge,
      termination,
      connections: Array.from({ length: connectionCount }, (_, index) => ({
        sourcePoint: sourcePointsByEdge[params.sourceEdge][index % 3]!,
      })),
    }) as PreparedBus

  return [
    ...[8, 8, 8].map((count, index) =>
      makeBus(`wide-${index}`, count, { type: "boundary" }),
    ),
    ...[2, 2, 2].map((count, index) =>
      makeBus(`pair-${index}`, count, { type: "boundary" }),
    ),
    ...[1, 1, 1].map((count, index) =>
      makeBus(`control-${index}`, count, { type: "boundary" }),
    ),
    ...Array.from({ length: 64 }, (_, index) =>
      makeBus(`plane-${index}`, 1, { type: "plane", layer: "inner1" }),
    ),
  ]
}

test("adaptive dense-plane routing selection is rotation invariant", () => {
  for (let turns = 0; turns < 4; turns++) {
    const sourceEdge = rotateEdge("left", turns)
    const exitEdge = rotateEdge("top", turns)
    expect(
      shouldUseAdaptiveDensePlaneRouting(
        createMemoryField({ sourceEdge, exitEdge }),
        false,
      ),
    ).toBe(true)
  }
})

test("adaptive dense-plane routing selection is reflection invariant", () => {
  for (const [sourceEdge, exitEdge] of [
    ["left", "top"],
    ["right", "top"],
    ["left", "bottom"],
    ["right", "bottom"],
  ] as const) {
    expect(
      shouldUseAdaptiveDensePlaneRouting(
        createMemoryField({ sourceEdge, exitEdge }),
        false,
      ),
    ).toBe(true)
  }
})

test("an edge-aligned memory field keeps the simpler routing strategy", () => {
  for (const edge of ["left", "top", "right", "bottom"] as const) {
    expect(
      shouldUseAdaptiveDensePlaneRouting(
        createMemoryField({ sourceEdge: edge, exitEdge: edge }),
        false,
      ),
    ).toBe(false)
  }
})

test("a straight-through opposite-edge field keeps the simpler strategy", () => {
  const oppositeEdge: Record<FanoutEdge, FanoutEdge> = {
    left: "right",
    right: "left",
    top: "bottom",
    bottom: "top",
  }
  for (const sourceEdge of ["left", "top", "right", "bottom"] as const) {
    expect(
      shouldUseAdaptiveDensePlaneRouting(
        createMemoryField({
          sourceEdge,
          exitEdge: oppositeEdge[sourceEdge],
        }),
        false,
      ),
    ).toBe(false)
  }
})
