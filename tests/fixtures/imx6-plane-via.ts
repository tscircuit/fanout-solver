import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type {
  SimpleRouteJson,
  SimplifiedPcbTrace,
} from "@tscircuit/capacity-autorouter"
import { getCopperLayerNames } from "lib/layer-names"
import { prepareFanoutBuses } from "lib/prepare-buses"
import { buildPlan } from "lib/route-bus/build-plan"
import type { Bounds, FanoutRoutePlan, FanoutSolverOptions } from "lib/types"

/** Native source_trace_7 and nearby geometry, copied without moving copper. */
export function createImx6PlaneVia(): {
  srj: SimpleRouteJson
  plan: FanoutRoutePlan
  viewport: Bounds
} {
  const captured: {
    solverParams: SimpleRouteJson
    solverOptions: FanoutSolverOptions
    candidateTrace: SimplifiedPcbTrace
    viewport: Bounds
  } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./imx6-terminal-pour-candidate.json.gz", import.meta.url),
      ),
    ).toString(),
  )
  const {
    solverParams: srj,
    solverOptions,
    candidateTrace,
    viewport,
  } = captured
  const bus = prepareFanoutBuses(srj, solverOptions)[0]!
  const viaIndex = candidateTrace.route.findIndex(
    (point) => point.route_type === "via",
  )
  const sourceEscapePath = candidateTrace.route
    .slice(0, viaIndex)
    .map((point) => {
      if (point.route_type !== "wire") {
        throw new Error("Expected source wires before the captured plane via")
      }
      return { x: point.x, y: point.y }
    })
  const plan = buildPlan({
    preparedConnection: bus.connections[0]!,
    bus,
    targetLayer: "inner2",
    layerNames: getCopperLayerNames(srj.layerCount),
    traceWidth: 0.119,
    viaDiameter: 0.4,
    viaHoleDiameter: 0.2,
    clearance: 0.119,
    track: sourceEscapePath[0]!.y,
    exitAxis: bus.sharedBoundary.maxX,
    viaHandedness: 0,
    interstitialEscape: true,
    spreadLaneIndex: 0,
    cornerExitLaneOffset: 0,
    cornerLocalChannelLaneOffset: 0,
    cornerBoundaryChannelLaneOffset: 0,
    terminateAtVia: true,
    allowBlindAndBuriedVias: false,
    sourceEscapePath,
  })
  return { srj, plan, viewport }
}
