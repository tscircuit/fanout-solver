import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBus } from "lib/route-bus"
import { createTwoViaWindows } from "./fixtures/two-via-windows"

test("plane directions constrain endpoint and atomic bus requests", () => {
  const { input, options } = createTwoViaWindows()
  const source = input.connections[0]!.pointsToConnect[0]!
  const signalSource = input.connections[1]!.pointsToConnect[0]!
  for (const scenario of [
    {
      connections: [
        {
          ...input.connections[0]!,
          pointsToConnect: [source, { x: 1, y: 0, layer: "inner1" }],
        },
      ],
      direction: "left" as const,
      correctedDirection: "right" as const,
      sourcePaths: [[source, { x: 0.3, y: 0 }]],
    },
    {
      connections: [
        input.connections[0]!,
        { ...input.connections[1]!, pointsToConnect: [signalSource] },
      ],
      direction: "right" as const,
      correctedDirection: "left" as const,
      sourcePaths: [
        [source, { x: -0.24, y: 0.24 }, { x: -0.24, y: 0.3 }],
        [signalSource, { x: 0.3, y: 0 }],
      ],
    },
  ]) {
    const srj = { ...input, connections: scenario.connections }
    const solver = new FanoutSolver(srj, {
      ...options,
      buses: [
        {
          busId: "plane",
          connectionNames: srj.connections.map((connection) => connection.name),
          direction: scenario.direction,
          termination: { type: "plane", layer: "inner1" },
        },
      ],
    })
    const bus = solver.preparedBuses[0]!
    const sourceEscapePaths = new Map(
      scenario.sourcePaths.map((path, index) => [index, path]),
    )
    const params = {
      ...solver.config,
      srj,
      bus,
      targetLayer: "inner1",
      acceptedPlans: [],
      sourceEscapePaths,
      fixedViaPointsByConnectionIndex: new Map(
        scenario.sourcePaths.map((path, index) => [index, path.at(-1)!]),
      ),
    }
    expect(routeBus(params)).toBeNull()
    const corrected = routeBus({
      ...params,
      bus: {
        ...bus,
        direction: scenario.correctedDirection,
        requestedDirection: scenario.correctedDirection,
      },
    })
    expect(corrected).toHaveLength(scenario.connections.length)
  }
})
