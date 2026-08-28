import { expect, test } from "bun:test"
import type {
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"
import { FanoutSolver } from "lib/fanout-solver"
import { getPcbSvgFromSrj } from "tests/fixtures/getPcbSvgFromSrj"
import capturedInput from "./fixtures/am62l-hdmi-u5-fanout.json"

// Captured from the AM62L board's U5 fanout phase. The fixture keeps the real
// SII9022ACNU footprint and four TMDS pairs while omitting unrelated board nets.
function getSourceTraceId(connection: SimpleRouteConnection): string {
  if (
    !("source_trace_id" in connection) ||
    typeof connection.source_trace_id !== "string"
  ) {
    throw new Error(`Connection ${connection.name} has no source_trace_id`)
  }
  return connection.source_trace_id
}

test("AM62L HDMI U5 fanout drops source trace identities", async () => {
  const inputSrj = capturedInput as SimpleRouteJson
  const sourceTraceIds = inputSrj.connections.map(getSourceTraceId)
  const solver = new FanoutSolver(inputSrj, {
    busDirections: Object.fromEntries(
      inputSrj.buses!.map((bus) => [bus.busId, "right"] as const),
    ),
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  const output = solver.getOutput()
  expect(output.validation).toMatchObject({ valid: true, issues: [] })
  expect(output.fanoutTraces).toHaveLength(8)
  expect(sourceTraceIds).toEqual([
    "source_trace_31",
    "source_trace_30",
    "source_trace_29",
    "source_trace_28",
    "source_trace_27",
    "source_trace_26",
    "source_trace_25",
    "source_trace_24",
  ])
  for (const trace of output.fanoutTraces) {
    expect(trace).not.toHaveProperty("source_trace_id")
    expect(trace.connectsTo).not.toEqual(expect.arrayContaining(sourceTraceIds))
  }

  await expect(
    getPcbSvgFromSrj(inputSrj, output.simpleRouteJson),
  ).toMatchSvgSnapshot(import.meta.path)
})
