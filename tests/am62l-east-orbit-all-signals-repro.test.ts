import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import capturedFixture from "./fixtures/am62l-east-orbit-all-signals-repro.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

test.failing("routes every AM62L DDR bus in the east-orbit fanout", async () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  solver.solve()

  expect(fixture.options.buses?.map((bus) => bus.busId)).toEqual([
    "DDR_BYTE0",
    "DDR_BYTE1",
    "DDR_ADDR_CTRL",
    "DDR_CLOCK",
    "DDR_DQS0",
    "DDR_DQS1",
    "DDR_RESET",
    "DDR_DMI0",
    "DDR_DMI1",
  ])
  expect(fixture.inputSrj.connections).toHaveLength(18)
  expect(solver.failed).toBe(true)
  expect(solver.error).toBe(
    "FanoutSolver: best layer assignment routed 12/18 connections",
  )
  expect(solver.attempts).toContainEqual(
    expect.objectContaining({
      routedBusCount: 6,
      routedConnectionCount: 12,
      failedBusIds: ["DDR_DQS1", "DDR_DMI0", "DDR_BYTE0"],
    }),
  )

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )

  expect(solver.solved).toBe(true)
}, 180_000)
