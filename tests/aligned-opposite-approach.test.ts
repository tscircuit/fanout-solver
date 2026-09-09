import { expect, test } from "bun:test"
import { FanoutSolver } from "../lib/fanout-solver"
import { getLayerReservedBusTargets } from "../lib/route-layer-reserved-buses"
import { hasAlignedOppositeApproach } from "../lib/aligned-opposite-approach"
import type { Point2D, PreparedBus } from "../lib/types"
import alignedFixture from "./fixtures/dataset31-k230-top-right-offset.json"
import crossingFixture from "./fixtures/dataset31-k230-top-center.json"
import outwardFixture from "./fixtures/dataset31-k230-right-center.json"

test("approach protection follows overlapping source and target corridors through every rotation", () => {
  const point = ({ x, y }: Point2D): Point2D => ({ x: -y, y: x })
  const rotate = (bus: PreparedBus): PreparedBus => ({
    ...bus,
    exitEdge: { top: "left", left: "bottom", bottom: "right", right: "top" }[
      bus.exitEdge!
    ] as PreparedBus["exitEdge"],
    componentBounds: {
      minX: -bus.componentBounds.maxY,
      maxX: -bus.componentBounds.minY,
      minY: bus.componentBounds.minX,
      maxY: bus.componentBounds.maxX,
    },
    connections: bus.connections.map((connection) => ({
      ...connection,
      sourceObstacle: {
        ...connection.sourceObstacle,
        center: point(connection.sourceObstacle.center),
        width: connection.sourceObstacle.height,
        height: connection.sourceObstacle.width,
      },
      sourcePoint: {
        ...connection.sourcePoint,
        ...point(connection.sourcePoint),
      },
    })),
  })
  for (const [fixture, expected] of [
    [alignedFixture, true],
    [crossingFixture, false],
    [outwardFixture, false],
  ] as const) {
    const input = fixture as unknown as {
      simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
      solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
    }
    const solver = new FanoutSolver(input.simpleRouteJson, input.solverOptions)
    let buses = solver.preparedBuses
    let exits = getLayerReservedBusTargets({
      ...solver.config,
      srj: input.simpleRouteJson,
      buses,
    })!.exits
    for (let turn = 0; turn < 4; turn++) {
      expect(hasAlignedOppositeApproach(buses, exits)).toBe(expected)
      expect(hasAlignedOppositeApproach(buses, new Map())).toBe(false)
      buses = buses.map(rotate)
      exits = new Map(
        [...exits].map(([index, target]) => [index, point(target)]),
      )
    }
  }
})
