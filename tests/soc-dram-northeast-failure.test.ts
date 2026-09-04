import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import dramBreakoutFixture from "./fixtures/soc-dram/northeast/dram-breakout.srj.json"
import socBreakoutFixture from "./fixtures/soc-dram/northeast/soc-breakout.srj.json"

type CapturedBreakoutInput = SimpleRouteJson & {
  allowBlindAndBuriedVias?: boolean
}

const fixtures = [
  {
    id: "soc",
    input: socBreakoutFixture as unknown as CapturedBreakoutInput,
    expectedDirection: "up",
    expectedSharedBoundary: {
      minX: -7.876999999999999,
      maxX: 7.876999999999999,
      minY: -7.876999999999999,
      maxY: 7.876999999999999,
    },
  },
  {
    id: "dram",
    input: dramBreakoutFixture as unknown as CapturedBreakoutInput,
    expectedDirection: "down",
    expectedSharedBoundary: {
      minX: 23.71250000000001,
      maxX: 44.287499999999994,
      minY: 25.800000000000015,
      maxY: 42.19999999999999,
    },
  },
] as const

test("records the current SoC and DRAM northeast breakout failures", async () => {
  for (const fixture of fixtures) {
    const input = structuredClone(fixture.input)
    expect(input.connections).toHaveLength(33)
    expect(input.buses).toHaveLength(3)
    expect(input.obstacles).toHaveLength(575)
    expect(input.layerCount).toBe(8)
    expect(input.allowBlindAndBuriedVias).toBe(false)

    const solver = new FanoutSolver(input)
    solver.solve()

    expect(solver.solved).toBe(false)
    expect(solver.failed).toBe(true)
    expect(String(solver.error)).toBe(
      "FanoutSolver: best layer assignment routed 0/33 connections",
    )
    expect(solver.attempts).toHaveLength(256)
    expect(
      Math.max(
        ...solver.attempts.map((attempt) => attempt.routedConnectionCount),
      ),
    ).toBe(0)
    expect(new Set(solver.preparedBuses.map((bus) => bus.direction))).toEqual(
      new Set([fixture.expectedDirection]),
    )
    expect(solver.preparedBuses[0]?.sharedBoundary).toEqual(
      fixture.expectedSharedBoundary,
    )

    await expect(
      getSvgFromGraphicsObject(solver.visualize()),
    ).toMatchSvgSnapshot(import.meta.path, `${fixture.id}-current-failure`)
  }
}, 30_000)
