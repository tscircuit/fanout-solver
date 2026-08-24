import { expect, test } from "bun:test"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutBusSpec, FanoutSolverOptions } from "lib/types"
import { createSingleSignalFanoutFixture } from "./fixtures/create-single-signal-fanout"

function createSolver(
  busOverrides: Partial<FanoutBusSpec>,
  options: Omit<FanoutSolverOptions, "buses"> = {},
): FanoutSolver {
  const { simpleRouteJson, bus } = createSingleSignalFanoutFixture(busOverrides)
  return new FanoutSolver(simpleRouteJson, { ...options, buses: [bus] })
}

test("canonical exit positions are atomic and reject conflicting legacy fields", () => {
  const canonicalSolver = createSolver(
    { exitPosition: "rightside_top" },
    {
      defaultDirection: "down",
      defaultPreferredExit: "bottom-left",
    },
  )
  expect(canonicalSolver.preparedBuses[0]).toMatchObject({
    direction: "up",
    preferredExit: "top-right",
    exitEdge: "right",
  })

  const centeredSolver = createSolver(
    { exitPosition: "center" },
    {
      defaultDirection: "down",
      defaultPreferredExit: "bottom-left",
    },
  )
  expect(centeredSolver.preparedBuses[0]?.direction).toBe("right")
  expect(centeredSolver.preparedBuses[0]?.preferredExit).toBeUndefined()
  expect(centeredSolver.preparedBuses[0]?.exitEdge).toBeUndefined()

  expect(() =>
    createSolver(
      {
        exitPosition: "rightside_top",
        direction: "up",
        preferredExit: "top-right",
        exitEdge: "right",
      },
      {
        busDirections: { BUS: "up" },
        busExitPreferences: { BUS: "top-right" },
      },
    ),
  ).not.toThrow()

  for (const conflict of [
    {
      busOverrides: {
        exitPosition: "rightside_top",
        direction: "down",
      } satisfies Partial<FanoutBusSpec>,
      options: {},
      message: 'conflicts with bus direction "down"',
    },
    {
      busOverrides: {
        exitPosition: "rightside_top",
        preferredExit: "bottom-right",
      } satisfies Partial<FanoutBusSpec>,
      options: {},
      message: 'conflicts with bus preferredExit "bottom-right"',
    },
    {
      busOverrides: {
        exitPosition: "rightside_top",
        exitEdge: "top",
      } satisfies Partial<FanoutBusSpec>,
      options: {},
      message: 'conflicts with bus exitEdge "top"',
    },
    {
      busOverrides: {
        exitPosition: "rightside_top",
      } satisfies Partial<FanoutBusSpec>,
      options: { busDirections: { BUS: "down" } },
      message: 'conflicts with busDirections direction "down"',
    },
    {
      busOverrides: {
        exitPosition: "rightside_top",
      } satisfies Partial<FanoutBusSpec>,
      options: { busExitPreferences: { BUS: "bottom-right" } },
      message: 'conflicts with busExitPreferences preferredExit "bottom-right"',
    },
    {
      busOverrides: {
        exitPosition: "center",
        direction: "up",
      } satisfies Partial<FanoutBusSpec>,
      options: {},
      message: 'exitPosition "center" conflicts with bus direction "up"',
    },
    {
      busOverrides: {
        exitPosition: "center",
        preferredExit: "right",
      } satisfies Partial<FanoutBusSpec>,
      options: {},
      message: 'exitPosition "center" conflicts with bus preferredExit "right"',
    },
    {
      busOverrides: {
        exitPosition: "center",
        exitEdge: "right",
      } satisfies Partial<FanoutBusSpec>,
      options: {},
      message: 'exitPosition "center" conflicts with bus exitEdge "right"',
    },
    {
      busOverrides: {
        exitPosition: "center",
      } satisfies Partial<FanoutBusSpec>,
      options: { busDirections: { BUS: "up" } },
      message:
        'exitPosition "center" conflicts with busDirections direction "up"',
    },
    {
      busOverrides: {
        exitPosition: "center",
      } satisfies Partial<FanoutBusSpec>,
      options: { busExitPreferences: { BUS: "right" } },
      message:
        'exitPosition "center" conflicts with busExitPreferences preferredExit "right"',
    },
  ] as const) {
    expect(() => createSolver(conflict.busOverrides, conflict.options)).toThrow(
      conflict.message,
    )
  }

  expect(() =>
    createSolver({
      exitPosition: "right_top" as FanoutBusSpec["exitPosition"],
    }),
  ).toThrow('invalid exitPosition "right_top"')
})
