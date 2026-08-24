import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { createSingleSignalFanoutFixture } from "./fixtures/create-single-signal-fanout"

test("inferred same-id connections preserve a requested canonical bus", () => {
  const { simpleRouteJson, bus } = createSingleSignalFanoutFixture({
    busId: "DDR",
    connectionNames: ["BUS_DDR_01"],
    exitPosition: "rightside_top",
    allowedLayers: ["bottom"],
  })
  simpleRouteJson.connections[0]!.name = "BUS_DDR_01"
  const firstSourceObstacle = simpleRouteJson.obstacles.find((obstacle) =>
    obstacle.connectedTo.includes("SIGNAL"),
  )!
  firstSourceObstacle.connectedTo = firstSourceObstacle.connectedTo.map(
    (connectionName) =>
      connectionName === "SIGNAL" ? "BUS_DDR_01" : connectionName,
  )

  const secondPointId = "soc-pad-0-1"
  simpleRouteJson.connections.push({
    name: "BUS_DDR_02",
    pointsToConnect: [
      {
        x: -0.35,
        y: 0.35,
        layer: "top",
        pointId: secondPointId,
      },
      { x: 2, y: -0.35, layer: "bottom" },
    ],
  })
  const secondSourceObstacle = simpleRouteJson.obstacles.find(
    (obstacle) => obstacle.obstacleId === secondPointId,
  )!
  secondSourceObstacle.connectedTo.push("BUS_DDR_02")

  const solver = new FanoutSolver(simpleRouteJson, {
    buses: [bus],
    defaultDirection: "down",
    defaultPreferredExit: "bottom-left",
  })

  expect(solver.preparedBuses).toHaveLength(1)
  expect(solver.preparedBuses[0]).toMatchObject({
    busId: "DDR",
    direction: "up",
    preferredExit: "top-right",
    exitEdge: "right",
    allowedLayers: ["bottom"],
  })
  expect(
    solver.preparedBuses[0]?.connections.map(
      (connection) => connection.connection.name,
    ),
  ).toEqual(["BUS_DDR_01", "BUS_DDR_02"])
})
