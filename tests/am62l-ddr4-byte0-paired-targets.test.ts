import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"

interface CapturedFixture {
  generatedFrom: {
    repository: string
    integrationCommit: string
    source: string
    capture: string
  }
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}

const fixture: CapturedFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/am62l-ddr4-byte0-paired-targets.json", import.meta.url),
    "utf8",
  ),
)

test("routes the exact AM62L DDR4 BYTE0 fanout toward its paired breakout exits", async () => {
  const { generatedFrom, simpleRouteJson, solverOptions } = fixture
  expect(generatedFrom).toEqual({
    repository: "https://github.com/tscircuit/core",
    integrationCommit: "9107d743",
    source: "tests/fixtures/am62l-ddr4-real/index.circuit.tsx",
    capture:
      "second FanoutSolver constructor, reduced only to the exact DDR_BYTE0 bus",
  })
  expect(simpleRouteJson.connections).toHaveLength(8)
  expect(simpleRouteJson.obstacles).toHaveLength(97)
  expect(simpleRouteJson.traces ?? []).toHaveLength(0)
  expect(solverOptions.buses).toHaveLength(1)

  const bus = solverOptions.buses![0]!
  expect(bus.busId).toBe("DDR_BYTE0")
  expect(bus.connectionNames).toHaveLength(8)
  expect(bus.allowedLayers).toEqual(["top", "inner4"])
  expect(bus.connectionExitTargets).toBeDefined()
  expect(
    Object.values(bus.connectionExitTargets!).every(
      (target) =>
        target.x > solverOptions.sharedBoundary!.maxX &&
        target.layer === "inner4",
    ),
  ).toBe(true)

  const solver = new FanoutSolver(
    structuredClone(simpleRouteJson),
    structuredClone(solverOptions),
  )
  solver.solve()

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
  expect(solver.failed, solver.error ?? undefined).toBe(false)
  expect(solver.solved).toBe(true)
  expect(solver.getOutput().fanoutTraces).toHaveLength(8)
}, 180_000)
