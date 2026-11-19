import {
  busUsesCoordinatedWindingChannel,
  getCornerSide,
} from "./route-bus/directions"
import type { PreparedBus } from "./types"

/** Winding vias and packed corner lanes require accepted routing context. */
export function canEnumerateIndependentBusRoutes(bus: PreparedBus): boolean {
  return (
    !busUsesCoordinatedWindingChannel(bus) &&
    (bus.termination.type !== "boundary" || !getCornerSide(bus))
  )
}
