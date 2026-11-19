import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("ordinary fanout honors requested widths and an explicit override", () => {
  for (const [request, configuredWidth, expectedWidth] of [
    [{ nominalTraceWidth: 0.14, width: 0.16 }, undefined, 0.14],
    [{ width: 0.16 }, undefined, 0.16],
    [{ nominalTraceWidth: 0.14 }, 0.12, 0.12],
    [{ nominalTraceWidth: 0.05 }, undefined, 0.1],
  ] as const) {
    const { input, options } = createTwoViaWindows()
    const solver = new FanoutSolver(
      {
        ...input,
        connections: [{ ...input.connections[1]!, ...request }],
      },
      { ...options, buses: [options.buses![1]!], traceWidth: configuredWidth },
    )
    solver.solve()
    expect(solver.solved).toBe(true)
    const widths = solver
      .getOutput()
      .fanoutTraces.flatMap((trace) =>
        trace.route.flatMap((point) =>
          point.route_type === "wire" ? [point.width] : [],
        ),
      )
    expect(new Set(widths)).toEqual(new Set([expectedWidth]))
  }

  const { input, options } = createTwoViaWindows()
  input.connections = [
    { ...input.connections[1]!, nominalTraceWidth: 0.14 },
    {
      name: "NC2",
      nominalTraceWidth: 0.16,
      pointsToConnect: [
        { x: 0.6, y: -0.6, layer: "top", pointId: "NC2" },
        { x: -2, y: -0.6, layer: "bottom" },
      ],
    },
  ]
  options.buses = [{ busId: "pair", connectionNames: ["DQ", "NC2"] }]
  expect(() => new FanoutSolver(input, options)).toThrow(
    'bus "pair" requests different trace widths',
  )
  expect(
    new FanoutSolver(input, { ...options, traceWidth: 0.12 }).preparedBuses[0]!
      .traceWidth,
  ).toBe(0.12)
})
