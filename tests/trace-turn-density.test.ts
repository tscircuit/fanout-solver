import { expect, test } from "bun:test"
import {
  checkTraceTurnDensity,
  measureTraceTurnDensity,
  summarizeTraceTurnDensity,
} from "lib/measure-trace-turn-density"
import type { FanoutSimplifiedPcbTrace } from "lib/types"
import {
  createTurnTrace,
  traceTurnDensityExamples,
} from "./fixtures/trace-turn-density"

test("trace turn density counts complete corners in a 5 mm path window", () => {
  const cases = [
    { name: "straight", turns: [], expected: 0 },
    { name: "single diagonal bend", turns: [45], expected: 0 },
    { name: "opposing half turns cancel", turns: [45, -45], expected: 0 },
    { name: "chamfered right angle", turns: [45, 45], expected: 1 },
    { name: "opposite complete turns", turns: [90, -90], expected: 2 },
    {
      name: "incomplete turns cannot accumulate across reversals",
      turns: [45, -45, 45, -45, 45, -45],
      expected: 0,
    },
    {
      name: "direction reversal preserves completed corners",
      turns: [45, 45, 45, -45, -45],
      expected: 2,
    },
    {
      name: "a reversal contributes two standalone corners",
      turns: [180],
      expected: 2,
    },
    {
      name: "a reversal does not join neighboring half turns",
      turns: [45, 180, 45],
      expected: 2,
    },
  ]
  for (const { name, turns, expected } of cases) {
    const trace = createTurnTrace(name, turns)
    const variants: FanoutSimplifiedPcbTrace[] = [
      trace,
      { ...trace, route: [...trace.route].reverse() },
      {
        ...trace,
        route: trace.route.map((point) => ({ ...point, x: -point.x })),
      },
    ]
    for (const variant of variants) {
      expect(measureTraceTurnDensity(variant).max90DegreeTurns).toBe(expected)
    }
  }

  // Two half turns exactly 5 mm apart form one corner; the next millimetre
  // fraction must not be borrowed from outside the measurement window.
  for (const [distance, expected] of [
    [5, 1],
    [5.001, 0],
  ]) {
    const trace = createTurnTrace("window-boundary", [45, 45], [1, distance, 1])
    expect(measureTraceTurnDensity(trace).max90DegreeTurns).toBe(expected)
  }

  // These three turns fit inside a 5 mm spatial diameter, but their first
  // and last corners are 6 mm apart along the copper.
  const longFold = createTurnTrace("folded-path", [90, 90, 90], [1, 3, 3, 1])
  const foldMetric = measureTraceTurnDensity(longFold)
  expect(foldMetric.max90DegreeTurns).toBe(2)
  expect(foldMetric.traceLengthMm).toBeCloseTo(8)
  expect(foldMetric.spanMm).toBe(5)
  expect(foldMetric.worstWindow?.turnCount).toBe(2)
  expect(
    foldMetric.worstWindow!.endDistanceMm -
      foldMetric.worstWindow!.startDistanceMm,
  ).toBeLessThanOrEqual(5 + 1e-9)

  const lateCorners = measureTraceTurnDensity(
    createTurnTrace("late-corners", [0, 0, 90, 90], [3, 3, 1, 1, 1]),
  )
  expect(lateCorners.max90DegreeTurns).toBe(2)
  expect(lateCorners.worstWindow!.startDistanceMm).toBeGreaterThan(0)
  expect(lateCorners.worstWindow!.points[0]).toEqual({ x: 4, y: 0 })
  expect(lateCorners.worstWindow!.points.at(-1)!.x).toBeCloseTo(6)
  expect(lateCorners.worstWindow!.points.at(-1)!.y).toBeCloseTo(1)

  const clean = createTurnTrace("redundant-vertices", [45, 45])
  const [first, second] = clean.route
  const redundant: FanoutSimplifiedPcbTrace = {
    ...clean,
    route: [
      first,
      { ...first },
      { ...first, x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      ...clean.route.slice(1),
    ],
  }
  expect(measureTraceTurnDensity(redundant).max90DegreeTurns).toBe(1)
  expect(measureTraceTurnDensity(redundant).traceLengthMm).toBeCloseTo(1.8)
  const noisyStraight = createTurnTrace("floating-point-straight", [5e-8, 5e-8])
  expect(measureTraceTurnDensity(noisyStraight).max90DegreeTurns).toBe(0)

  const beforeVia = createTurnTrace("layer-sections", [90], 1)
  const end = beforeVia.route.at(-1)!
  const afterVia = createTurnTrace("layer-sections", [90], 1, "bottom")
  const bottomRoute = afterVia.route.map((point) => ({
    ...point,
    x: point.x + end.x,
    y: point.y + end.y,
  }))
  for (const via of [false, true]) {
    const trace: FanoutSimplifiedPcbTrace = {
      ...beforeVia,
      route: [
        ...beforeVia.route,
        ...(via
          ? [
              {
                route_type: "via" as const,
                x: end.x,
                y: end.y,
                from_layer: "top",
                to_layer: "bottom",
              },
            ]
          : []),
        ...bottomRoute,
      ],
    }
    const metric = measureTraceTurnDensity(trace)
    expect(metric.max90DegreeTurns).toBe(1)
    expect(metric.traceLengthMm).toBeCloseTo(4)
  }

  // Changing direction through a via does not create an in-plane bend.
  const throughVia: FanoutSimplifiedPcbTrace = {
    ...beforeVia,
    route: [
      { route_type: "wire", x: 0, y: 0, width: 0.12, layer: "top" },
      { route_type: "wire", x: 1, y: 0, width: 0.12, layer: "top" },
      { route_type: "via", x: 1, y: 0, from_layer: "top", to_layer: "bottom" },
      { route_type: "wire", x: 1, y: 0, width: 0.12, layer: "bottom" },
      { route_type: "wire", x: 1, y: 1, width: 0.12, layer: "bottom" },
    ],
  }
  expect(measureTraceTurnDensity(throughVia).max90DegreeTurns).toBe(0)

  const empty = measureTraceTurnDensity({ ...clean, route: [] })
  expect(empty).toMatchObject({
    max90DegreeTurns: 0,
    traceLengthMm: 0,
    worstWindow: null,
  })
  for (const invalid of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    expect(() =>
      measureTraceTurnDensity({ ...clean, route: [{ ...first, x: invalid }] }),
    ).toThrow()
    expect(() =>
      measureTraceTurnDensity({ ...clean, route: [{ ...first, y: invalid }] }),
    ).toThrow()
    expect(() =>
      measureTraceTurnDensity({
        ...clean,
        route: [
          {
            route_type: "via",
            x: invalid,
            y: 0,
            from_layer: "top",
            to_layer: "bottom",
          },
        ],
      }),
    ).toThrow()
  }

  const metrics = traceTurnDensityExamples.map(measureTraceTurnDensity)
  expect(metrics.map((metric) => metric.max90DegreeTurns)).toEqual([0, 1, 2, 4])
  expect(summarizeTraceTurnDensity(metrics)).toEqual({
    traceCount: 4,
    median: 1.5,
    max: 4,
  })
  expect(summarizeTraceTurnDensity(metrics.slice(0, 3))).toEqual({
    traceCount: 3,
    median: 1,
    max: 2,
  })
  expect(summarizeTraceTurnDensity([])).toEqual({
    traceCount: 0,
    median: null,
    max: null,
  })

  const checked = checkTraceTurnDensity(traceTurnDensityExamples, {
    max90DegreeTurns: 2,
  })
  expect(checked.valid).toBe(false)
  expect(checked.limit).toBe(2)
  expect(checked.issues).toEqual([
    {
      pcbTraceId: "Dense alternating corners",
      connectionName: "Dense alternating corners",
      max90DegreeTurns: 4,
    },
  ])
  expect(
    checkTraceTurnDensity(traceTurnDensityExamples, { max90DegreeTurns: 4 })
      .valid,
  ).toBe(true)
  for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      checkTraceTurnDensity([], { max90DegreeTurns: invalid }),
    ).toThrow()
  }
})
