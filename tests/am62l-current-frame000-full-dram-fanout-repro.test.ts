import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"
import capturedFixture from "./fixtures/am62l-current-frame000-full-dram-fanout-repro.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}
const fixturePath = new URL(
  "./fixtures/am62l-current-frame000-full-dram-fanout-repro.json",
  import.meta.url,
).pathname
const witnessPath = new URL(
  "./helpers/run-complete-fanout-witness.ts",
  import.meta.url,
).pathname

const runBoundedWitness = async (timeoutMs: number) => {
  const child = Bun.spawn([process.execPath, witnessPath, fixturePath], {
    stdout: "ignore",
    stderr: "ignore",
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, timeoutMs)
  try {
    return { exitCode: await child.exited, timedOut }
  } finally {
    clearTimeout(timeout)
    if (timedOut) await child.exited
  }
}

test("captures the current complete frame-000 DRAM fanout", () => {
  const { inputSrj, options } = fixture
  expect(inputSrj.connections).toHaveLength(143)
  expect(inputSrj.obstacles).toHaveLength(217)
  expect(inputSrj.traces).toHaveLength(135)
  expect(inputSrj.minViaHoleDiameter).toBe(0.15)
  expect(options.buses).toHaveLength(119)
  expect(
    options.buses?.filter((bus) => bus.termination?.type === "plane"),
  ).toHaveLength(110)

  const busById = new Map(options.buses?.map((bus) => [bus.busId, bus]))
  expect(
    Object.values(busById.get("DDR_BYTE0")?.connectionExitTargets ?? {}).map(
      ({ y }) => y,
    ),
  ).toEqual([
    2.7076400000000005, 2.3863600000000003, 3.9927600000000005,
    3.6714800000000003, 3.0289200000000003, 3.3502, 4.31404, 4.63532,
  ])
  expect(
    Object.values(busById.get("DDR_CLOCK")?.connectionExitTargets ?? {}).map(
      ({ y }) => y,
    ),
  ).toEqual([5.920440000000001, 6.241720000000001])
  expect(
    Object.values(busById.get("DDR_DQS0")?.connectionExitTargets ?? {}).map(
      ({ y }) => y,
    ),
  ).toEqual([5.59916, 5.27788])
  expect(
    Object.values(busById.get("DDR_DMI0")?.connectionExitTargets ?? {}).map(
      ({ y }) => y,
    ),
  ).toEqual([4.9566])
  expect(
    Object.values(busById.get("DDR_DMI1")?.connectionExitTargets ?? {}).map(
      ({ y }) => y,
    ),
  ).toEqual([-5.7598])
})

test("routes the current 143-connection frame-000 DRAM fanout within thirty seconds", async () => {
  expect(await runBoundedWitness(30_000)).toEqual({
    exitCode: 0,
    timedOut: false,
  })
}, 40_000)
