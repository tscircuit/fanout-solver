import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"

interface CapturedFixture {
  generatedFrom: {
    repository: string
    commit: string
    sample: string
    generator: string
  }
  simpleRouteJson: ConstructorParameters<typeof FanoutSolver>[0]
  solverOptions: NonNullable<ConstructorParameters<typeof FanoutSolver>[1]>
}

const fixture: CapturedFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/am62l-ddr4-processor.json", import.meta.url),
    "utf8",
  ),
)

test("captures the isolated AM62L DDR4 processor fanout", async () => {
  const { generatedFrom, simpleRouteJson, solverOptions } = fixture
  expect(generatedFrom).toEqual({
    repository: "https://github.com/tscircuit/dataset-fanout31-am62l",
    commit: "8eabec2516c5066d43ec7672511a1134430c5d45",
    sample: "samples/73-am62l-ddr4-processor.tsx",
    generator: "scripts/generate-repro/generate-am62l-ddr4-processor.tsx",
  })
  expect(simpleRouteJson.connections).toHaveLength(49)
  expect(simpleRouteJson.obstacles).toHaveLength(422)
  expect(simpleRouteJson.traces ?? []).toHaveLength(0)
  expect(simpleRouteJson.layerCount).toBe(10)
  expect(simpleRouteJson.minTraceWidth).toBe(0.08)
  expect(simpleRouteJson.minTraceToPadEdgeClearance).toBe(0.08)
  expect(simpleRouteJson.minViaHoleDiameter).toBe(0.15)
  expect(simpleRouteJson.minViaPadDiameter).toBe(0.25)
  expect(Reflect.get(simpleRouteJson, "allowBlindAndBuriedVias")).toBe(false)
  expect(Reflect.get(simpleRouteJson, "allowViaInPad")).not.toBe(true)
  expect(solverOptions.buses).toHaveLength(23)
  expect(
    solverOptions.buses?.flatMap((bus) => bus.connectionNames),
  ).toHaveLength(49)

  const solver = new FanoutSolver(
    structuredClone(simpleRouteJson),
    structuredClone(solverOptions),
  )
  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
})
