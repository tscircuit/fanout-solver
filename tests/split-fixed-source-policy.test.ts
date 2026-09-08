import { expect, test } from "bun:test"
import { FanoutSolver } from "../lib/fanout-solver"
import { hasOppositeFixedWideBus } from "../lib/route-source-origin-buses"
import type { Point2D, PreparedBus } from "../lib/types"
import oppositeFixture from "./fixtures/dataset31-k230-top-center.json"
import outwardFixture from "./fixtures/dataset31-k230-right-center.json"

test("stronger source cost follows opposite source geometry through every rotation", () => {
  const point = ({ x, y }: Point2D): Point2D => ({ x: -y, y: x })
  const rotate = (bus: PreparedBus): PreparedBus => ({
    ...bus,
    exitEdge: {
      top: "left",
      left: "bottom",
      bottom: "right",
      right: "top",
    }[bus.exitEdge!] as PreparedBus["exitEdge"],
    componentBounds: {
      minX: -bus.componentBounds.maxY,
      maxX: -bus.componentBounds.minY,
      minY: bus.componentBounds.minX,
      maxY: bus.componentBounds.maxX,
    },
    connections: bus.connections.map((connection) => ({
      ...connection,
      sourcePoint: {
        ...connection.sourcePoint,
        ...point(connection.sourcePoint),
      },
    })),
  })
  for (const [fixture, expected] of [
    [oppositeFixture, true],
    [outwardFixture, false],
  ] as const) {
    const input = fixture as unknown as {
      simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
      solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
    }
    let buses = new FanoutSolver(input.simpleRouteJson, input.solverOptions)
      .preparedBuses
    for (let turn = 0; turn < 4; turn++) {
      expect(hasOppositeFixedWideBus(buses)).toBe(expected)
      buses = buses.map(rotate)
    }
  }
})
