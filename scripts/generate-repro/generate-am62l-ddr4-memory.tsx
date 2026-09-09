import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createAm62lDdr4FanoutSample } from "@tscircuit/dataset-fanout31-am62l/lib/create-am62l-ddr4-fanout-sample"
import { dataset31Source } from "./dataset31-source"

const sample = await createAm62lDdr4FanoutSample("memory")
const fixture = {
  generatedFrom: {
    ...dataset31Source,
    sample: "samples/74-am62l-ddr4-memory.tsx",
    generator: "scripts/generate-repro/generate-am62l-ddr4-memory.tsx",
  },
  ...sample,
}
const outputPath = resolve(
  import.meta.dir,
  "../../tests/fixtures/am62l-ddr4-memory.json",
)
writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(
  `Captured ${sample.id}: ${sample.simpleRouteJson.connections.length} connections, ${sample.simpleRouteJson.obstacles.length} obstacles`,
)
console.log(outputPath)
