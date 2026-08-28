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

test("AM62L HDMI U5 fanout preserves source trace identities", async () => {
  const inputSrj = capturedInput as SimpleRouteJson
  const sourceTraceIdByConnectionName = new Map(
    inputSrj.connections.map(
      (connection) => [connection.name, getSourceTraceId(connection)] as const,
    ),
  )
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
  expect([...sourceTraceIdByConnectionName.values()]).toEqual([
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
    const sourceTraceId = sourceTraceIdByConnectionName.get(
      trace.connection_name,
    )
    expect(trace.source_trace_id).toBe(sourceTraceId)
    expect(trace.connectsTo).toContain(sourceTraceId)
    expect(trace.connectsTo?.at(-2)).toBe(sourceTraceId)
    expect(trace.connectsTo?.at(-1)).toMatch(/^fanout-exit:/)
  }

  await expect(
    getPcbSvgFromSrj(inputSrj, output.simpleRouteJson),
  ).toMatchSvgSnapshot(import.meta.path)
})
