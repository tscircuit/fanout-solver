import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { createAm62lRealDecouplingRepro } from "./create-am62l-real-decoupling-repro"

const captured = await createAm62lRealDecouplingRepro({
  captureTarget: "dram",
  minViaHoleEdgeToViaHoleEdgeClearance: "0.254mm",
})
const selectedBusIds = [
  "U2_VDDQ_W12_DROP",
  "U2_VDDQ_AA3_DROP",
  "U2_VDDQ_AA5_DROP",
  "U2_VDDQ_AA8_DROP",
  "U2_VDDQ_AA10_DROP",
  "U2_VDD2_A4_DROP",
  "U2_VDD2_A9_DROP",
  "U2_VDD2_F5_DROP",
  "DDR_BYTE0",
]
const selectedBusIdSet = new Set(selectedBusIds)
const buses = captured.options.buses!.filter((bus) =>
  selectedBusIdSet.has(bus.busId),
)
const connectionNames = new Set(buses.flatMap((bus) => bus.connectionNames))
const reducedInput = {
  ...captured.inputSrj,
  connections: captured.inputSrj.connections.filter((connection) =>
    connectionNames.has(connection.name),
  ),
  buses: captured.inputSrj.buses?.filter((bus) =>
    selectedBusIdSet.has(bus.busId),
  ),
  differentialPairs: captured.inputSrj.differentialPairs?.filter((pair) =>
    pair.connectionNames.every((name) => connectionNames.has(name)),
  ),
}

const connectedToSets: string[][] = []
const connectedToSetIndexByKey = new Map<string, number>()
const obstacles = reducedInput.obstacles.map(({ connectedTo, ...obstacle }) => {
  const key = JSON.stringify(connectedTo)
  let connectedToSetIndex = connectedToSetIndexByKey.get(key)
  if (connectedToSetIndex === undefined) {
    connectedToSetIndex = connectedToSets.length
    connectedToSets.push(connectedTo)
    connectedToSetIndexByKey.set(key, connectedToSetIndex)
  }
  return { ...obstacle, connectedToSetIndex }
})

const fixture = {
  generatedFrom: {
    repository: "https://github.com/tscircuit/core",
    pullRequest: 3783,
    sourceCircuit:
      "scripts/generate-repro/create-am62l-real-decoupling-repro.tsx",
    generator:
      "scripts/generate-repro/generate-am62l-drill-hole-clearance-repro.tsx",
    reduction: "eight LPDDR4 plane drops and the complete DDR_BYTE0 bus",
  },
  selectedBusIds,
  connectedToSets,
  inputSrj: { ...reducedInput, obstacles },
  options: { ...captured.options, buses },
}
const outputPath = resolve(
  import.meta.dir,
  "../../tests/fixtures/am62l-drill-hole-clearance-repro.json.gz",
)
writeFileSync(outputPath, gzipSync(`${JSON.stringify(fixture)}\n`))
console.log(
  `Captured ${reducedInput.connections.length} real AM62L/LPDDR4 connections from ${buses.length} buses`,
)
console.log(outputPath)
