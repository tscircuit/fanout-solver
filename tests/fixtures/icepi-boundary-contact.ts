import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import type { FanoutSolverOptions } from "lib/types"

/** Select one native boundary request without changing obstacles or rules. */
export function createIcepiBoundaryContact(): {
  srj: SimpleRouteJson
  solverOptions: FanoutSolverOptions
} {
  const captured: {
    solverParams: SimpleRouteJson
    solverOptions: FanoutSolverOptions
  } = JSON.parse(
    gunzipSync(
      new Uint8Array(
        readFileSync(
          new URL("./icepi-boundary-contact.json.gz", import.meta.url),
        ),
      ),
    ).toString(),
  )
  const connection = captured.solverParams.connections.find(
    (candidate) => candidate.name === "breakout:pcb_breakout_point_0",
  )
  if (!connection) throw new Error("Native iCE/Pi boundary request is missing")
  return {
    srj: { ...captured.solverParams, connections: [connection], buses: [] },
    solverOptions: { ...captured.solverOptions, buses: [] },
  }
}
