import assert from "node:assert/strict"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "../../lib/fanout-solver"
import type { FanoutSolverOptions } from "../../lib/types"
import { validateRoutedCopperDrc } from "../../lib/validate-routed-copper-drc"

const fixturePath = process.argv[2]
if (!fixturePath) throw new Error("Expected a fixture path")

const fixture = (await Bun.file(fixturePath).json()) as {
  inputSrj: SimpleRouteJson
  options: FanoutSolverOptions
}
const { inputSrj, options } = fixture
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
