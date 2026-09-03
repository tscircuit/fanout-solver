import { FANOUT_DIRECTION_CASES } from "@tscircuit/dataset-fanout31-am62l/lib/fanout-directions"
import generatorPackage from "./package.json"

const dependency =
  generatorPackage.dependencies["@tscircuit/dataset-fanout31-am62l"]
const commit = dependency.match(
  /^github:tscircuit\/dataset-fanout31-am62l#([a-f0-9]{40})$/,
)?.[1]
if (!commit)
  throw new Error("Dataset 31 must be pinned to an exact upstream commit")

export const dataset31Source = {
  repository: "https://github.com/tscircuit/dataset-fanout31-am62l",
  commit,
}
export { FANOUT_DIRECTION_CASES }
