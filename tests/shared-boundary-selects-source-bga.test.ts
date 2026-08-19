import { expect, test } from "bun:test"
import type { Obstacle, SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

const signalPadIndexes = [5, 6, 9, 10]

function createBga16Obstacles(
  componentId: string,
  centerX: number,
): Obstacle[] {
  return Array.from({ length: 16 }, (_, padIndex) => {
    const pointId = `${componentId}-pad-${padIndex + 1}`
    const connectionIndex = signalPadIndexes.indexOf(padIndex)
    return {
      obstacleId: pointId,
      componentId,
      type: "rect" as const,
      center: {
        x: centerX + (padIndex % 4) * 0.8 - 1.2,
        y: Math.floor(padIndex / 4) * 0.8 - 1.2,
      },
      width: 0.35,
      height: 0.35,
      layers: ["top"],
      connectedTo: [
        pointId,
        ...(connectionIndex < 0 ? [] : [`DATA${connectionIndex}`]),
      ],
    }
  })
}

test("source component scope selects which BGA endpoint to fan out", async () => {
  const leftBgaPads = createBga16Obstacles("U1_LEFT", -4)
  const rightBgaPads = createBga16Obstacles("U2_RIGHT", 4)
  const simpleRouteJson: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -7, maxX: 7, minY: -4, maxY: 4 },
    obstacles: [...leftBgaPads, ...rightBgaPads],
    connections: signalPadIndexes.map((padIndex, connectionIndex) => ({
      name: `DATA${connectionIndex}`,
      pointsToConnect: [
        {
          ...leftBgaPads[padIndex]!.center,
          layer: "top",
          pointId: leftBgaPads[padIndex]!.obstacleId,
        },
        {
          ...rightBgaPads[padIndex]!.center,
          layer: "top",
          pointId: rightBgaPads[padIndex]!.obstacleId,
        },
      ],
    })),
    buses: [
      {
        busId: "DATA_BUS",
        connectionNames: signalPadIndexes.map(
          (_, connectionIndex) => `DATA${connectionIndex}`,
        ),
      },
    ],
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    sourcePcbComponentIds: ["U2_RIGHT"],
    sharedBoundary: { minX: 1, maxX: 7, minY: -3, maxY: 3 },
    escapeLayers: ["top", "bottom"],
    compactBusTracks: true,
    borderDistribution: "even",
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.preparedBuses[0]).toMatchObject({
    componentId: "U2_RIGHT",
    direction: "left",
  })
  const output = solver.getOutput()
  expect(output.validation.valid).toBe(true)
  await expect(
    getPcbSvgFromSrj(simpleRouteJson, output.simpleRouteJson),
  ).toMatchSvgSnapshot(import.meta.path)
})
