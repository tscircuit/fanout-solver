import { expect, test } from "bun:test"
import { fanoutDataset06 } from "../datasets/dataset06"
import { FanoutSolver } from "../lib/fanout-solver"

test("adaptive single-layer routing respects available boundary regions", () => {
  const sample = fanoutDataset06[0]!
  const buses = sample.solverOptions.buses!.map(
    ({ direction: _direction, preferredExit: _preferredExit, ...bus }) => bus,
  )
  const {
    busDirections: _busDirections,
    busExitPreferences: _busExitPreferences,
    ...solverOptions
  } = sample.solverOptions
  const simpleRouteJson = {
    ...sample.simpleRouteJson,
    buses,
  }
  const solver = new FanoutSolver(simpleRouteJson, {
    ...solverOptions,
    buses,
    availableCornersAndSides: [
      "top_left",
      "top_middle",
      "top_right",
      "right_top",
      "right_middle",
      "right_bottom",
      "bottom_right",
      "bottom_middle",
      "bottom_left",
    ],
  })

  solver.solve()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.attempts[0]).toMatchObject({
    routedConnectionCount: 132,
    routedBusCount: 132,
  })
  const output = solver.getOutput()
  expect(output.fanoutTraces).toHaveLength(132)
  expect(
    output.fanoutTraces.every((trace) => {
      const exit = trace.route.at(-1)
      return (
        exit?.route_type === "wire" &&
        Math.abs(exit.x - sample.sharedBoundary.minX) > 1e-6
      )
    }),
  ).toBe(true)
  expect(Object.values(output.busDirections)).not.toContain("left")
}, 60_000)
