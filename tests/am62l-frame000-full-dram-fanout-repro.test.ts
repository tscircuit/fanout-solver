import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"
import capturedFixture from "./fixtures/am62l-frame000-full-dram-fanout-repro.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}
const fixturePath = new URL(
  "./fixtures/am62l-frame000-full-dram-fanout-repro.json",
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
    // The witness has no descendants. SIGKILL guarantees that synchronous
    // solver work cannot defer termination, and awaiting `exited` reaps it.
    child.kill(9)
  }, timeoutMs)
  try {
    return { exitCode: await child.exited, timedOut }
  } finally {
    clearTimeout(timeout)
    if (timedOut) await child.exited
  }
}

test("captures the complete frame-000 DRAM fanout", () => {
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
    Object.values(busById.get("DDR_CLOCK")?.connectionExitTargets ?? {}).map(
      ({ y }) => y,
    ),
  ).toEqual([-2.5428678787878787, -2.040307878787879])
  expect(
    Object.values(busById.get("DDR_DMI1")?.connectionExitTargets ?? {}).map(
      ({ y }) => y,
    ),
  ).toEqual([1.4776121212121214])
})

test("reaps a witness that exceeds its timeout", async () => {
  const result = await runBoundedWitness(10)
  expect(result.timedOut).toBe(true)
  expect(result.exitCode).not.toBe(0)
}, 2_000)

test("routes all 143 frame-000 DRAM connections within thirty seconds", async () => {
  expect(await runBoundedWitness(30_000)).toEqual({
    exitCode: 0,
    timedOut: false,
  })
}, 40_000)
