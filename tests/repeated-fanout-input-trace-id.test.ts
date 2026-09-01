import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"

test("repeated fanout emits a trace ID already present in its input", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, maxX: 3, minY: -1, maxY: 1 },
    obstacles: [
      {
        obstacleId: "soc-pad-a1",
        componentId: "soc",
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: ["DDR_D0", "soc:A1"],
      },
    ],
    connections: [
      {
        name: "DDR_D0",
        pointsToConnect: [
          {
            x: 0,
            y: 0,
            layer: "top",
            pointId: "soc:A1",
            pcb_port_id: "soc:A1",
          },
          { x: 3, y: 0, layer: "top" },
        ],
      },
    ],
    buses: [{ busId: "DDR", connectionNames: ["DDR_D0"] }],
  }
  const options = {
    sharedBoundary: { minX: -0.5, maxX: 2, minY: -0.8, maxY: 0.8 },
    escapeLayers: ["top", "bottom"],
  }

  const firstSolver = new FanoutSolver(input, options)
  firstSolver.solve()
  expect(firstSolver.failed).toBe(false)
  const firstTrace = firstSolver.getOutput().fanoutTraces[0]!

  const secondSolver = new FanoutSolver(
    { ...input, traces: [firstTrace] },
    options,
  )
  secondSolver.solve()
  expect(secondSolver.failed).toBe(false)

  const secondOutput = secondSolver.getOutput()
  expect(secondOutput.fanoutTraces).toHaveLength(1)
  expect(secondOutput.fanoutTraces[0]!.pcb_trace_id).toBe(
    firstTrace.pcb_trace_id,
  )
  expect(
    secondOutput.simpleRouteJson.traces?.filter(
      (trace) => trace.pcb_trace_id === firstTrace.pcb_trace_id,
    ),
  ).toHaveLength(2)
})
