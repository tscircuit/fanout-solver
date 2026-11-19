import type {
  SimpleRouteConnection,
  SimpleRouteJson,
} from "@tscircuit/capacity-autorouter"

export interface TraceWidthContext {
  srj: Pick<SimpleRouteJson, "minTraceWidth" | "nominalTraceWidth">
  configuredTraceWidth?: number
}

export function getTraceWidth(
  params: TraceWidthContext & {
    connection?: SimpleRouteConnection & { width?: number }
  },
): number {
  const { srj, configuredTraceWidth, connection } = params
  const traceWidth =
    configuredTraceWidth ??
    connection?.nominalTraceWidth ??
    connection?.width ??
    srj.nominalTraceWidth ??
    srj.minTraceWidth
  if (!Number.isFinite(traceWidth) || traceWidth <= 0) {
    const request = connection ? ` for "${connection.name}"` : ""
    throw new Error(`FanoutSolver: invalid trace width${request}: ${traceWidth}`)
  }
  return Math.max(srj.minTraceWidth, traceWidth)
}
