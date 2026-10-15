import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec } from "lib/types"
import { getPcbSvgFromSrj } from "./fixtures/getPcbSvgFromSrj"

test("sequential plane fanouts retain earlier plane declarations and copper", async () => {
  const connectionNames = ["GND_A", "VCC_B"]
  const centers = [-1.25, 1.25]
  const connections: SimpleRouteJson["connections"] = connectionNames.map(
    (name, index) => ({
      name,
      pointsToConnect: [
        {
          x: centers[index]! - 0.4,
          y: 0.4,
          layer: "top",
          pointId: `${name}:pad`,
          pcb_port_id: `${name}:pad`,
        },
      ],
    }),
  )
  const inputSrj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -1.5, maxY: 1.5 },
    connections,
    obstacles: centers.flatMap((center, packageIndex) =>
      [
        [-0.4, 0.4],
        [0.4, 0.4],
        [-0.4, -0.4],
        [0.4, -0.4],
      ].map(([x, y], padIndex) => ({
        obstacleId: `package-${packageIndex}:pad-${padIndex}`,
        componentId: `package-${packageIndex}`,
        type: "rect" as const,
        shape: "circle",
        center: { x: center + x!, y: y! },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo:
          padIndex === 0
            ? [
                connectionNames[packageIndex]!,
                `${connectionNames[packageIndex]}:pad`,
              ]
            : [],
      })),
    ),
  }
  const planeBus = (connectionName: string, layer: string): FanoutBusSpec => ({
    busId: connectionName,
    connectionNames: [connectionName],
    direction: "right",
    termination: { type: "plane", layer },
  })

  const first = new FanoutSolver(
    { ...inputSrj, connections: [connections[0]!] },
    {
      buses: [planeBus("GND_A", "inner1")],
      sharedBoundary: inputSrj.bounds,
    },
  )
  first.solve()
  expect(first.failed).toBe(false)
  const firstOutput = first.getOutputSimpleRouteJson()
  const firstBefore = JSON.stringify(firstOutput)
  expect(firstOutput.fanoutPlaneConnectivity).toEqual([
    { connectionName: "GND_A", layer: "inner1" },
  ])

  const second = new FanoutSolver(
    { ...firstOutput, connections: [connections[1]!] },
    {
      buses: [planeBus("VCC_B", "inner2")],
      sharedBoundary: inputSrj.bounds,
    },
  )
  second.solve()
  expect(second.failed).toBe(false)
  const output = second.getOutputSimpleRouteJson()
  expect(output.fanoutPlaneConnectivity).toEqual([
    { connectionName: "GND_A", layer: "inner1" },
    { connectionName: "VCC_B", layer: "inner2" },
  ])
  expect(output.traces).toHaveLength(2)
  expect(output.traces).toContainEqual(firstOutput.traces![0])
  expect(output.obstacles).toEqual(
    expect.arrayContaining(firstOutput.obstacles),
  )
  expect(JSON.stringify(firstOutput)).toBe(firstBefore)

  const unchanged = new FanoutSolver(output, {
    sharedBoundary: inputSrj.bounds,
  })
  unchanged.solve()
  expect(unchanged.failed).toBe(false)
  const unchangedOutput = unchanged.getOutputSimpleRouteJson()
  expect(unchangedOutput.fanoutPlaneConnectivity).toEqual(
    output.fanoutPlaneConnectivity,
  )
  expect(unchangedOutput.traces).toEqual(output.traces)
  expect(unchangedOutput.obstacles).toEqual(output.obstacles)
  unchangedOutput.fanoutPlaneConnectivity![0]!.layer = "bottom"
  expect(output.fanoutPlaneConnectivity![0]!.layer).toBe("inner1")

  await expect(getPcbSvgFromSrj(inputSrj, output)).toMatchSvgSnapshot(
    import.meta.path,
  )
})
