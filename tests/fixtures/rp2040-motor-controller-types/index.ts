import type { FanoutBusSpec } from "../../../lib/types"

// The motor-controller's strict source check follows fanout-solver's published
// .ts files even with skipLibCheck. Accept immutable caller-owned layer lists.
const layers = ["top", "bottom"] as const
const bus: FanoutBusSpec = {
  busId: "usb",
  connectionNames: [],
  allowedLayers: layers,
}
const mutableBus: FanoutBusSpec = {
  busId: "qspi",
  connectionNames: [],
  allowedLayers: ["top"],
}
void [bus, mutableBus]
