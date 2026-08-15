import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

const createBgaPads = ({
  componentId,
  center,
  connectedPoint,
}: {
  componentId: string
  center: { x: number; y: number }
  connectedPoint: { x: number; y: number; pointId: string }
}): SimpleRouteJson["obstacles"] => {
  const pads: SimpleRouteJson["obstacles"] = []
  for (let row = -2; row <= 2; row++) {
    for (let column = -2; column <= 2; column++) {
      const x = center.x + column * 0.45
      const y = center.y + row * 0.45
      const isConnected =
        Math.abs(x - connectedPoint.x) < 1e-9 &&
        Math.abs(y - connectedPoint.y) < 1e-9
      pads.push({
        obstacleId: `${componentId}-${row + 2}-${column + 2}`,
        componentId,
        type: "rect",
        center: { x, y },
        width: 0.25,
        height: 0.25,
        layers: ["top"],
        connectedTo: isConnected ? [connectedPoint.pointId] : [],
      })
    }
  }
  return pads
}

test("visual regression: sequential fanouts keep both real copper escapes", async () => {
  const leftPoint = { x: -1.1, y: 0, pointId: "left-point" }
  const rightPoint = { x: 1.1, y: 0, pointId: "right-point" }
  const inputSrj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaHoleDiameter: 0.15,
    minViaPadDiameter: 0.3,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -3.5, maxX: 3.5, minY: -2, maxY: 2 },
    obstacles: [
      ...createBgaPads({
        componentId: "left-bga",
        center: { x: -2, y: 0 },
        connectedPoint: leftPoint,
      }),
      ...createBgaPads({
        componentId: "right-bga",
        center: { x: 2, y: 0 },
        connectedPoint: rightPoint,
      }),
    ],
    connections: [
      {
        name: "SIGNAL",
        pointsToConnect: [
          { ...leftPoint, layer: "top" },
          { ...rightPoint, layer: "top" },
        ],
      },
    ],
  }

  const leftFanout = new FanoutSolver(inputSrj, {
    buses: [
      {
        busId: "left-fanout",
        connectionNames: ["SIGNAL"],
        sourceComponentId: "left-bga",
        direction: "right",
      },
    ],
    sharedBoundary: { minX: -3.25, maxX: -0.7, minY: -1.25, maxY: 1.25 },
    escapeLayers: ["inner1"],
  })
  leftFanout.solve()

  const rightFanout = new FanoutSolver(leftFanout.getOutputSimpleRouteJson(), {
    buses: [
      {
        busId: "right-fanout",
        connectionNames: ["SIGNAL"],
        sourceComponentId: "right-bga",
        direction: "left",
      },
    ],
    sharedBoundary: { minX: 0.7, maxX: 3.25, minY: -1.25, maxY: 1.25 },
    escapeLayers: ["inner1"],
  })
  rightFanout.solve()

  const output = rightFanout.getOutputSimpleRouteJson()
  const traceIds = (output.traces ?? []).map((trace) => trace.pcb_trace_id)
  expect(traceIds).toHaveLength(2)
  expect(new Set(traceIds).size).toBe(2)

  // Circuit JSON consumers index pcb_trace elements by ID. Reproduce that
  // normalization before rendering the actual emitted board and copper.
  await expect(
    getPcbSvgFromSrj(inputSrj, output, { deduplicateTraceIds: true }),
  ).toMatchSvgSnapshot(import.meta.path)
})
