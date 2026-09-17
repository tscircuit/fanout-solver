import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import capturedFixture from "./fixtures/am62l-north-orbit-byte0-fanout-repro.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

test.failing("routes all eight AM62L DDR byte-0 signals through the north-orbit fanout", async () => {
  const solver = new FanoutSolver(fixture.inputSrj, fixture.options)
  solver.solve()

  expect(solver.failed).toBe(true)
  expect(solver.error).toBe(
    "FanoutSolver: best layer assignment routed 0/8 connections",
  )
  expect(solver.attempts).toEqual([
    {
      assignmentIndex: 0,
      busLayerAssignments: { DDR_BYTE0: "inner1" },
      routedBusCount: 0,
      routedConnectionCount: 0,
      failedBusIds: ["DDR_BYTE0"],
      score: 8_100_000.01,
    },
  ])

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )

  expect(solver.solved).toBe(true)
}, 60_000)
