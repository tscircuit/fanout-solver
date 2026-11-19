import type { SimpleRouteConnection } from "@tscircuit/capacity-autorouter"

export function getConnectionTraceWidth(
  connection: SimpleRouteConnection & { width?: number },
  defaultWidth: number,
  minimumWidth: number,
  configuredOverride?: number,
): number {
  // Newer SRJs use nominalTraceWidth; native captures can still use its legacy alias.
  const width =
    configuredOverride ??
    connection.nominalTraceWidth ??
    connection.width ??
    defaultWidth
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(
      `FanoutSolver: invalid trace width for "${connection.name}": ${width}`,
    )
  }
  return Math.max(minimumWidth, width)
}
