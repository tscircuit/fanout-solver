import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { getCopperLayerNames } from "lib/layer-names"
import { prepareFanoutBuses } from "lib/prepare-buses"
import type { RouteBusParams } from "lib/route-bus"
import type { FanoutSolverOptions } from "lib/types"

// Native fanout-region cut; the capture metadata records the bounds and halo.
export function createIcepiPlaneDrop(): RouteBusParams {
  const captured: {
    solverParams: SimpleRouteJson
    solverOptions: FanoutSolverOptions
  } = JSON.parse(
    gunzipSync(
      new Uint8Array(
        readFileSync(new URL("./icepi-plane-drop.json.gz", import.meta.url)),
      ),
    ).toString(),
  )
  const srj = captured.solverParams
  const bus = prepareFanoutBuses(srj, captured.solverOptions).find(
    (prepared) => prepared.busId === "ESC_U22_pin101",
  )
  if (!bus || bus.termination.type !== "plane") {
    throw new Error("Native iCE/Pi U22 ground plane drop is missing")
  }
  if (
    srj.minViaPadDiameter === undefined ||
    srj.minViaHoleDiameter === undefined ||
    srj.minViaEdgeToPadEdgeClearance === undefined
  ) {
    throw new Error("Native iCE/Pi via rules are missing")
  }
  return {
    srj,
    bus,
    targetLayer: bus.termination.layer,
    acceptedPlans: [],
    layerNames: getCopperLayerNames(srj.layerCount),
    traceWidth: srj.minTraceWidth,
    viaDiameter: srj.minViaPadDiameter,
    viaHoleDiameter: srj.minViaHoleDiameter,
    clearance: srj.minViaEdgeToPadEdgeClearance,
    compactBusTracks: true,
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: false,
  }
}
