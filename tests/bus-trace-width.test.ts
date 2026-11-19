import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("bus widths must agree unless a common width is configured", () => {
  const { input, options } = createTwoViaWindows()
  const srj = {
    ...input,
    connections: [
      { ...input.connections[1]!, nominalTraceWidth: 0.1 },
      {
        name: "NC2",
        nominalTraceWidth: 0.14,
        pointsToConnect: [
          { x: 0.6, y: -0.6, layer: "top", pointId: "NC2" },
          { x: -2, y: -0.6, layer: "bottom" },
        ],
      },
    ],
  }
  const busOptions = {
    ...options,
    buses: [{ busId: "pair", connectionNames: ["DQ", "NC2"] }],
  }
  expect(() => new FanoutSolver(srj, busOptions)).toThrow(
    'bus "pair" requests different trace widths',
  )
  const configured = new FanoutSolver(srj, {
    ...busOptions,
    traceWidth: 0.12,
  })
  expect(configured.preparedBuses[0]!.traceWidth).toBe(0.12)
  const uniform = new FanoutSolver(
    {
      ...srj,
      connections: srj.connections.map((connection) => ({
        ...connection,
        nominalTraceWidth: 0.14,
      })),
    },
    busOptions,
  )
  expect(uniform.preparedBuses[0]!.traceWidth).toBe(0.14)
})
