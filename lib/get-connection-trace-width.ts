import type { SimpleRouteConnection } from "@tscircuit/capacity-autorouter"

export function getConnectionTraceWidth(params: {
  connection: SimpleRouteConnection & { width?: number }
  defaultTraceWidth: number
  minimumTraceWidth: number
  configuredTraceWidth?: number
}): number {
  const {
    connection,
    defaultTraceWidth,
    minimumTraceWidth,
    configuredTraceWidth,
  } = params
  const traceWidth =
    configuredTraceWidth ??
    connection.nominalTraceWidth ??
    connection.width ??
    defaultTraceWidth
  if (!Number.isFinite(traceWidth) || traceWidth <= 0)
    throw new Error(
      `FanoutSolver: invalid trace width for "${connection.name}": ${traceWidth}`,
    )
  return Math.max(minimumTraceWidth, traceWidth)
}
