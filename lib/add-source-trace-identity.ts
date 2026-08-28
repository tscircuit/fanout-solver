import type { SimpleRouteConnection } from "@tscircuit/capacity-autorouter"
import type { FanoutSimplifiedPcbTrace } from "./types"

function getSourceTraceId(
  connection: SimpleRouteConnection,
): string | undefined {
  if (
    "source_trace_id" in connection &&
    typeof connection.source_trace_id === "string"
  ) {
    return connection.source_trace_id
  }
  return undefined
}

function insertSourceTraceIdBeforeTerminal({
  connectsTo,
  sourceTraceId,
}: {
  connectsTo: string[]
  sourceTraceId: string
}): string[] {
  if (connectsTo.includes(sourceTraceId)) return connectsTo
  if (connectsTo.length === 0) return [sourceTraceId]
  return [
    ...connectsTo.slice(0, -1),
    sourceTraceId,
    connectsTo[connectsTo.length - 1]!,
  ]
}

export function addSourceTraceIdentity({
  connection,
  trace,
}: {
  connection: SimpleRouteConnection
  trace: FanoutSimplifiedPcbTrace
}): FanoutSimplifiedPcbTrace {
  const sourceTraceId = getSourceTraceId(connection)
  if (!sourceTraceId) return trace
  return {
    ...trace,
    source_trace_id: sourceTraceId,
    connectsTo: insertSourceTraceIdBeforeTerminal({
      connectsTo: trace.connectsTo ?? [],
      sourceTraceId,
    }),
  }
}
