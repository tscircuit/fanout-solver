import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createAm62lFanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-am62l-fanout-sample"
import { dataset31Source } from "./dataset31-source"

// The upstream TSX renders the paired AM62L/LPDDR4 breakouts through core's
// renderUntilSettled and intercepts the constructor after implicit winding.
// Keep every connection, obstacle, exit target, and solver option unchanged.
const sample = await createAm62lFanoutSample("topside_center")
const fixture = {
  generatedFrom: {
    ...dataset31Source,
    sample: "samples/02-top-center.tsx",
    generator: "scripts/generate-repro/generate-dataset-fanout31-top.tsx",
  },
  ...sample,
}
const outputPath = resolve(
  import.meta.dir,
  "../../datasets/fixtures/fanout31-am62l-top-center.json",
)
writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(
  `Captured ${sample.id}: ${sample.simpleRouteJson.connections.length} connections, ${sample.simpleRouteJson.obstacles.length} obstacles`,
)
console.log(outputPath)
