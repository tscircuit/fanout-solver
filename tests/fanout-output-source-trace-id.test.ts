import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { getPcbSvgFromSrj } from "tests/fixtures/getPcbSvgFromSrj"

type SimpleRouteJsonWithSourceTraceIds = Omit<
  SimpleRouteJson,
  "connections"
> & {
  connections: Array<
    SimpleRouteJson["connections"][number] & { source_trace_id: string }
  >
}

test("fanout output drops the input source trace id", async () => {
  const connectionName = "DDR_D0"
  const sourceTraceId = "source_trace_ddr_d0"
  const simpleRouteJson: SimpleRouteJsonWithSourceTraceIds = {
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
        connectedTo: [connectionName, sourceTraceId, "soc:A1"],
      },
    ],
    connections: [
      {
        name: connectionName,
        source_trace_id: sourceTraceId,
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
    buses: [
      {
        busId: "DDR",
        connectionNames: [connectionName],
        sourceComponentId: "soc",
        direction: "right",
      },
    ] as FanoutBusSpec[],
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    sharedBoundary: { minX: -0.5, maxX: 2, minY: -0.8, maxY: 0.8 },
    escapeLayers: ["top", "bottom"],
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(1)
  expect(output.fanoutTraces[0]).not.toHaveProperty("source_trace_id")
  await expect(
    getPcbSvgFromSrj(simpleRouteJson, output.simpleRouteJson),
  ).toMatchSvgSnapshot(import.meta.path)
})
