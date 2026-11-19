import type { SimpleRouteConnection } from "@tscircuit/capacity-autorouter"
import { getTraceWidth, type TraceWidthContext } from "./get-trace-width"

export function getBusTraceWidth(
  {
    busId,
    connections,
  }: { busId: string; connections: readonly SimpleRouteConnection[] },
  context: TraceWidthContext,
): number {
  const [firstConnection, ...remainingConnections] = connections
  if (!firstConnection) {
    throw new Error(`FanoutSolver: bus "${busId}" has no connections`)
  }
  const traceWidth = getTraceWidth({ ...context, connection: firstConnection })
  if (
    remainingConnections.some(
      (connection) =>
        Math.abs(getTraceWidth({ ...context, connection }) - traceWidth) > 1e-9,
    )
  ) {
    throw new Error(
      `FanoutSolver: bus "${busId}" requests different trace widths; configure a common traceWidth or split the bus`,
    )
  }
  return traceWidth
}
