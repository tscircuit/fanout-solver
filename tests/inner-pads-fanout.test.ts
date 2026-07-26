import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import { fanoutDataset01 } from "../datasets/dataset01"

test("inner BGA pads receive via fanouts", () => {
  for (const sample of fanoutDataset01) {
    const solver = new FanoutSolver(
      sample.simpleRouteJson,
      sample.solverOptions,
    )
    solver.solve()
    const output = solver.getOutput()

    const padsByComponent = Map.groupBy(
      sample.simpleRouteJson.obstacles.filter(
        (obstacle) => obstacle.componentId,
      ),
      (obstacle) => obstacle.componentId!,
    )
    for (const pads of padsByComponent.values()) {
      const xCoordinates = [...new Set(pads.map((pad) => pad.center.x))].sort(
        (a, b) => a - b,
      )
      const yCoordinates = [...new Set(pads.map((pad) => pad.center.y))].sort(
        (a, b) => a - b,
      )
      const innerPads = pads.filter(
        (pad) =>
          pad.center.x > xCoordinates[0]! &&
          pad.center.x < xCoordinates.at(-1)! &&
          pad.center.y > yCoordinates[0]! &&
          pad.center.y < yCoordinates.at(-1)!,
      )
      expect(innerPads.length).toBeGreaterThan(0)

      for (const pad of innerPads) {
        const trace = output.fanoutTraces.find((candidate) =>
          pad.connectedTo.includes(candidate.connection_name),
        )
        expect(trace).toBeDefined()
        expect(
          trace?.route.some((routePoint) => routePoint.route_type === "via"),
        ).toBe(true)
      }
    }
  }
})
