import assert from "node:assert/strict"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "../../lib/fanout-solver"
import type { FanoutSolverOptions } from "../../lib/types"
import { validateRoutedCopperDrc } from "../../lib/validate-routed-copper-drc"

const fixturePath = process.argv[2]
if (!fixturePath) throw new Error("Expected a fixture path")

const fixture = (await Bun.file(fixturePath).json()) as {
  inputSrj?: SimpleRouteJson
  input?: SimpleRouteJson
  options: FanoutSolverOptions
}
const inputSrj = fixture.inputSrj ?? fixture.input
assert.ok(inputSrj, "Fixture must contain inputSrj or input")
const { options } = fixture
const solver = new FanoutSolver(inputSrj, options)
solver.solve()

assert.equal(solver.solved, true, solver.error ?? "Fanout did not solve")
assert.equal(solver.failed, false, solver.error ?? "Fanout failed")

const output = solver.getOutput()
assert.equal(output.fanoutTraces.length, inputSrj.connections.length)
assert.equal(
  new Set(output.fanoutTraces.map((trace) => trace.connection_name)).size,
  inputSrj.connections.length,
)
assert.deepEqual(output.validation, {
  valid: true,
  checkedConnectionCount: inputSrj.connections.length,
  brokenOutConnectionCount: inputSrj.connections.length,
  issues: [],
})

const clearance =
  options.clearance ??
  inputSrj.minViaEdgeToPadEdgeClearance ??
  inputSrj.minTraceToPadEdgeClearance ??
  inputSrj.minTraceWidth
const drc = validateRoutedCopperDrc({
  inputSrj,
  routedSrj: {
    ...output.simpleRouteJson,
    traces: output.fanoutTraces,
  },
  clearance,
  allowBlindAndBuriedVias: false,
})
assert.deepEqual(drc.issues, [])
assert.equal(drc.valid, true)
assert.equal(drc.checkedTraceCount, inputSrj.connections.length)
assert.equal(drc.checkedViaCount, inputSrj.connections.length)

const orderedCornerBusIds = ["DDR_DMI0", "DDR_DQS0", "DDR_CLOCK"]
const orderedCornerBuses = orderedCornerBusIds.map((busId) =>
  options.buses?.find((bus) => bus.busId === busId),
)
if (process.argv.includes("--assert-ddr-corner-order")) {
  for (const [busIndex, bus] of orderedCornerBuses.entries()) {
    assert.ok(bus, `Missing ${orderedCornerBusIds[busIndex]} bus`)
  }
  const targetTrackByConnectionName = new Map<string, number>()
  for (const bus of orderedCornerBuses) {
    for (const connectionName of bus!.connectionNames) {
      const target = bus!.connectionExitTargets?.[connectionName]
      assert.ok(target, `Missing explicit target for ${connectionName}`)
      targetTrackByConnectionName.set(connectionName, target.y)
    }
  }
  const exitTrackByConnectionName = new Map(
    output.fanoutTraces.flatMap((trace) => {
      if (!targetTrackByConnectionName.has(trace.connection_name ?? "")) {
        return []
      }
      const wire = trace.route.findLast((point) => point.route_type === "wire")
      assert.equal(wire?.route_type, "wire")
      return [[trace.connection_name!, wire.y] as const]
    }),
  )
  const connectionNames = [...targetTrackByConnectionName.keys()]
  for (let firstIndex = 0; firstIndex < connectionNames.length; firstIndex++) {
    const firstName = connectionNames[firstIndex]!
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < connectionNames.length;
      secondIndex++
    ) {
      const secondName = connectionNames[secondIndex]!
      const targetOrder =
        targetTrackByConnectionName.get(firstName)! -
        targetTrackByConnectionName.get(secondName)!
      const exitOrder =
        exitTrackByConnectionName.get(firstName)! -
        exitTrackByConnectionName.get(secondName)!
      assert.ok(
        targetOrder * exitOrder >= -1e-9,
        `Breakout lane inversion: ${firstName} <> ${secondName}`,
      )
    }
  }
}
