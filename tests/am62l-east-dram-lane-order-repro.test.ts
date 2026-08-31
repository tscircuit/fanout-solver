import { expect, test } from "bun:test"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { getSvgFromGraphicsObject } from "graphics-debug"
import { FanoutSolver } from "lib/fanout-solver"
import type { FanoutSimplifiedPcbTrace, FanoutSolverOptions } from "lib/types"
import { validateRoutedCopperDrc } from "lib/validate-routed-copper-drc"
import capturedFixture from "./fixtures/am62l-east-dram-lane-order-repro.json"

const fixture = capturedFixture as unknown as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}

const orderedLaneBusIds = ["DDR_CLOCK", "DDR_DQS0", "DDR_DMI0"] as const

type SolvedFixture = {
  solver: FanoutSolver
  output: ReturnType<FanoutSolver["getOutput"]>
}

let solvedFixture: SolvedFixture | undefined

const solveFixture = (): SolvedFixture => {
  if (solvedFixture) return solvedFixture
  const solver = new FanoutSolver(
    structuredClone(fixture.inputSrj),
    structuredClone(fixture.options),
  )
  solver.solve()
  solvedFixture = { solver, output: solver.getOutput() }
  return solvedFixture
}

const getLastWire = (trace: FanoutSimplifiedPcbTrace) => {
  const wire = trace.route.findLast((point) => point.route_type === "wire")
  if (wire?.route_type !== "wire") {
    throw new Error(`Missing boundary wire for ${trace.connection_name}`)
  }
  return wire
}

const getLaneOrderInversions = (
  traces: readonly FanoutSimplifiedPcbTrace[],
) => {
  const buses = fixture.options.buses ?? []
  const connectionLabelByName = new Map<string, string>()
  const targetTrackByName = new Map<string, number>()
  for (const busId of orderedLaneBusIds) {
    const bus = buses.find((candidate) => candidate.busId === busId)
    if (!bus) throw new Error(`Missing ${busId}`)
    for (const [index, connectionName] of bus.connectionNames.entries()) {
      const target = bus.connectionExitTargets?.[connectionName]
      if (!target) throw new Error(`Missing target for ${connectionName}`)
      connectionLabelByName.set(connectionName, `${busId}[${index}]`)
      targetTrackByName.set(connectionName, target.y)
    }
  }

  const exitTrackByName = new Map(
    traces
      .filter((trace) => connectionLabelByName.has(trace.connection_name ?? ""))
      .map((trace) => [trace.connection_name!, getLastWire(trace).y] as const),
  )
  const connectionNames = [...connectionLabelByName.keys()]
  const inversions: string[] = []
  for (let firstIndex = 0; firstIndex < connectionNames.length; firstIndex++) {
    const firstName = connectionNames[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < connectionNames.length;
      secondIndex++
    ) {
      const secondName = connectionNames[secondIndex]!
      const firstTargetTrack = targetTrackByName.get(firstName)!
      const secondTargetTrack = targetTrackByName.get(secondName)!
      const firstExitTrack = exitTrackByName.get(firstName)
      const secondExitTrack = exitTrackByName.get(secondName)
      if (firstExitTrack === undefined || secondExitTrack === undefined) {
        throw new Error("Missing routed exit track")
      }
      if (
        (firstTargetTrack - secondTargetTrack) *
          (firstExitTrack - secondExitTrack) <
        -1e-9
      ) {
        inversions.push(
          `${connectionLabelByName.get(firstName)} <> ${connectionLabelByName.get(secondName)}`,
        )
      }
    }
  }
  return inversions
}

test("captures the AM62L east-orbit DRAM lane-order inversion", async () => {
  expect(fixture.inputSrj.connections).toHaveLength(33)
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

  const { solver, output } = solveFixture()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(output.fanoutTraces).toHaveLength(33)
  expect(output.validation).toEqual({
    valid: true,
    checkedConnectionCount: 33,
    brokenOutConnectionCount: 33,
    issues: [],
  })
  expect(
    validateRoutedCopperDrc({
      inputSrj: fixture.inputSrj,
      routedSrj: output.simpleRouteJson,
      clearance:
        fixture.options.clearance ??
        fixture.inputSrj.minViaEdgeToPadEdgeClearance ??
        fixture.inputSrj.minTraceToPadEdgeClearance ??
        fixture.inputSrj.minTraceWidth,
      allowBlindAndBuriedVias: false,
    }),
  ).toMatchObject({
    valid: true,
    checkedTraceCount: 33,
    checkedViaCount: 33,
    issues: [],
  })
  expect(getLaneOrderInversions(output.fanoutTraces)).toEqual([
    "DDR_CLOCK[0] <> DDR_DMI0[0]",
    "DDR_CLOCK[1] <> DDR_DMI0[0]",
    "DDR_DQS0[0] <> DDR_DMI0[0]",
    "DDR_DQS0[1] <> DDR_DMI0[0]",
  ])

  await expect(getSvgFromGraphicsObject(solver.visualize())).toMatchSvgSnapshot(
    import.meta.path,
  )
}, 120_000)

test.failing("preserves target lane order at the DRAM fanout boundary", () => {
  const { output } = solveFixture()
  expect(getLaneOrderInversions(output.fanoutTraces)).toEqual([])
})
