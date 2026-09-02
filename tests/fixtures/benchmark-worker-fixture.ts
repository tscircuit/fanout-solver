import { readFileSync } from "node:fs"
const { sample } = JSON.parse(readFileSync(0, "utf8"))
if (sample.id === "timeout") {
  while (true) Math.sqrt(Math.random())
}
if (sample.id === "error") throw new Error("Intentional worker crash")
if (sample.id === "malformed") {
  console.log("not JSON")
} else {
  console.log(
    JSON.stringify({
      dataset: sample.dataset,
      sample: sample.id,
      status: "solved",
      scope: "fanout",
      connections: 1,
      routed: 1,
      validatedBreakouts: 1,
      connectedOriginalConnections: null,
      routedCopperDrcValid: null,
      attempts: 1,
      vias: 0,
      milliseconds: 1,
    }),
  )
}
