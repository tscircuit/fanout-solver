import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createAm62lFanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-am62l-fanout-sample"

// The upstream TSX renders the paired AM62L/LPDDR4 breakouts through core's
// renderUntilSettled and intercepts the constructor after implicit winding.
// Keep every connection, obstacle, exit target, and solver option unchanged.
const sample = await createAm62lFanoutSample("leftside_center")
const fixture = {
  generatedFrom: {
    repository: "https://github.com/tscircuit/dataset-fanout31-am62l",
    commit: "8c73befb36b125c84651c07454a9b940b3c6500a",
    sample: "samples/11-left-center.tsx",
    generator: "scripts/generate-repro/generate-dataset-fanout31-left.tsx",
  },
  ...sample,
}
const outputPath = resolve(
  import.meta.dir,
  "../../datasets/fixtures/fanout31-am62l-left-center.json",
)
writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(
  `Captured ${sample.id}: ${sample.simpleRouteJson.connections.length} connections, ${sample.simpleRouteJson.obstacles.length} obstacles`,
)
console.log(outputPath)
