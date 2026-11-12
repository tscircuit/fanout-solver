import type { SimpleRouteJson } from "@tscircuit/capacity-autorouter"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"

export function loadMt8395HdmiInput(): SimpleRouteJson {
  const packed = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./mt8395-hdmi-core-input.packed.json.gz", import.meta.url),
      ),
    ).toString(),
  )
  if (packed.format !== "srj_obstacle_ids_v1")
    throw Error("Unexpected core fixture format")
  for (const obstacle of packed.input.obstacles)
    obstacle.connectedTo = obstacle.connectedTo.map(
      (index: number) => packed.ids[index],
    )
  if (hashMt8395Input(packed.input) !== packed.sha256)
    throw Error("Core input checksum mismatch")
  return packed.input
}

export function hashMt8395Input(input: SimpleRouteJson): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex")
}
