import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { routeBus } from "lib/route-bus"
import type { FanoutBusSpec, Point2D } from "lib/types"

const sourceConnectionName = "VSS_A1"
const obstacleConnectionName = "VSS_B1"
const sourcePoint: Point2D = { x: -0.5, y: 0 }
const fixedViaPoint: Point2D = { x: 0.5, y: 0 }

function routeFixedPlaneEscape(obstacleNetName: string) {
  const buses: FanoutBusSpec[] = [
    {
      busId: "ground",
      connectionNames: [sourceConnectionName],
      sourceComponentId: "bga",
      direction: "right",
      termination: { type: "plane", layer: "inner1" },
    },
    {
      busId: "other-plane",
      connectionNames: [obstacleConnectionName],
      sourceComponentId: "other",
      direction: "left",
      termination: { type: "plane", layer: "inner1" },
    },
  ]
  const srj: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    nominalTraceWidth: 0.1,
    minViaPadDiameter: 0.25,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minViaEdgeToPadEdgeClearance: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1.5, maxX: 1.5, minY: -1, maxY: 1 },
    connections: [
      {
        name: sourceConnectionName,
        netConnectionName: "GND",
        pointsToConnect: [
          {
            ...sourcePoint,
            layer: "top",
            pointId: "bga:A1",
            pcb_port_id: "bga:A1",
          },
        ],
      },
      {
        name: obstacleConnectionName,
        netConnectionName: obstacleNetName,
        pointsToConnect: [
          {
            ...fixedViaPoint,
            layer: "top",
            pointId: "other:B1",
            pcb_port_id: "other:B1",
          },
        ],
      },
    ],
    obstacles: [
      {
        obstacleId: "source-pad",
        componentId: "bga",
        type: "rect",
        center: sourcePoint,
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [sourceConnectionName, "bga:A1"],
      },
      {
        obstacleId: "other-pad",
        componentId: "other",
        type: "rect",
        center: fixedViaPoint,
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [obstacleConnectionName, "other:B1"],
      },
    ],
    buses: buses as NonNullable<SimpleRouteJson["buses"]>,
  }
  const solver = new FanoutSolver(srj, {
    buses,
    sharedBoundary: srj.bounds,
    escapeLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  })
  const bus = solver.preparedBuses.find(({ busId }) => busId === "ground")!
  const connectionIndex = bus.connections[0]!.connectionIndex

  return routeBus({
    srj,
    bus,
    targetLayer: "inner1",
    acceptedPlans: [],
    layerNames: ["top", "inner1", "inner2", "bottom"],
    traceWidth: 0.1,
    viaDiameter: 0.25,
    viaHoleDiameter: 0.15,
    clearance: 0.1,
    compactBusTracks: false,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
    fixedSourceEscapePathsByConnectionIndex: new Map([
      [connectionIndex, [sourcePoint, fixedViaPoint]],
    ]),
  })
}

test("a fixed plane escape can touch another obstacle on its electrical net", () => {
  const plans = routeFixedPlaneEscape("GND")

  expect(plans).toHaveLength(1)
  expect(plans![0]!.segments).toContainEqual(
    expect.objectContaining({ start: sourcePoint, end: fixedViaPoint }),
  )
  expect(plans![0]!.via?.center).toEqual(fixedViaPoint)
})

test("a fixed plane escape rejects the same obstacle on a different net", () => {
  expect(routeFixedPlaneEscape("VDD")).toBeNull()
})
