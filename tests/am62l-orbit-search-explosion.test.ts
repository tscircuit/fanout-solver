import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSolverOptions } from "lib/types"
import northFixtureJson from "./fixtures/am62l-north-orbit-search-explosion.json"
import southFixtureJson from "./fixtures/am62l-south-orbit-search-explosion.json"

type Fixture = {
  input: SimpleRouteJson
  options: FanoutSolverOptions
}

const northFixture = northFixtureJson as unknown as Fixture
const southFixture = southFixtureJson as unknown as Fixture
const witnessPath = new URL(
  "./helpers/run-orbit-search-witness.ts",
  import.meta.url,
).pathname

const runBoundedWitness = async (fixturePath: string, timeoutMs: number) => {
  const child = Bun.spawn([process.execPath, witnessPath, fixturePath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), timeoutMs)
  const exitCode = await child.exited
  clearTimeout(timeout)
  return exitCode
}

test("starts the north orbit on target-aligned layers instead of a mixed assignment", () => {
  const solver = new FanoutSolver(northFixture.input, northFixture.options)
  expect(solver.layerAssignments[0]).toEqual({
    DDR_BYTE0: "inner4",
    DDR_BYTE1: "inner5",
  })
})

test("captures the minimized north orbit geometry", async () => {
  const solver = new FanoutSolver(northFixture.input, northFixture.options)
  expect(northFixture.input.connections).toHaveLength(16)
  expect(northFixture.input.obstacles).toHaveLength(373)
  expect(northFixture.options.buses?.map((bus) => bus.busId)).toEqual([
    "DDR_BYTE0",
    "DDR_BYTE1",
  ])
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})

test("completes the minimized north orbit routing step within ten seconds", async () => {
  const exitCode = await runBoundedWitness(
    new URL(
      "./fixtures/am62l-north-orbit-search-explosion.json",
      import.meta.url,
    ).pathname,
    10_000,
  )
  expect(exitCode).toBe(0)
}, 15_000)

test("completes the minimized south orbit routing step within ten seconds", async () => {
  expect(southFixture.input.connections).toHaveLength(5)
  expect(southFixture.input.obstacles).toHaveLength(373)
  expect(southFixture.options.buses?.map((bus) => bus.busId)).toEqual([
    "DDR_ADDR_CTRL",
  ])
  const exitCode = await runBoundedWitness(
    new URL(
      "./fixtures/am62l-south-orbit-search-explosion.json",
      import.meta.url,
    ).pathname,
    10_000,
  )
  expect(exitCode).toBe(0)
}, 15_000)
