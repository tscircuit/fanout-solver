import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("uses requested conductor widths independently of unrelated plane buses", () => {
  for (const [mixed, request, configuredWidth, expectedWidth] of [
    [true, { width: 0.14 }, undefined, 0.14],
    [true, { nominalTraceWidth: 0.12, width: 0.14 }, undefined, 0.12],
    [true, { nominalTraceWidth: 0.12 }, 0.14, 0.14],
    [true, { nominalTraceWidth: 0.05 }, undefined, 0.1],
    [false, { nominalTraceWidth: 0.14 }, undefined, 0.14],
    [false, { nominalTraceWidth: 0.14 }, 0.12, 0.12],
  ] as const) {
    const { input, options } = createTwoViaWindows()
    const signal = { ...input.connections[1]!, ...request }
    const solver = new FanoutSolver(
      {
        ...input,
        connections: mixed ? [input.connections[0]!, signal] : [signal],
      },
      {
        ...options,
        traceWidth: configuredWidth,
        buses: mixed ? options.buses : [options.buses![1]!],
      },
    )
    solver.solve()
    const wires = solver
      .getOutput()
      .fanoutTraces.filter((trace) => trace.connection_name === signal.name)
      .flatMap((trace) =>
        trace.route.filter((point) => point.route_type === "wire"),
      )
    expect(new Set(wires.map((wire) => wire.width))).toEqual(
      new Set([expectedWidth]),
    )
  }
})
