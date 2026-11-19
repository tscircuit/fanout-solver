import type { FanoutDirection, PreparedBus } from "./types"

export function getSingletonCandidateHeadings(
  bus: PreparedBus,
): readonly FanoutDirection[] {
  const connection = bus.connections[0]!
  if (
    bus.exitEdge ||
    bus.preferredExit ||
    bus.requestedDirection ||
    connection.hasExplicitExitTarget ||
    connection.hasExplicitLayeredExitTarget
  )
    return [bus.direction]
  return ["left", "right", "up", "down"]
}
