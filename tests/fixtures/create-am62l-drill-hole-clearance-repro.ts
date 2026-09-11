import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { FanoutSolver } from "../../lib/fanout-solver"

const captured = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./am62l-drill-hole-clearance-repro.json.gz", import.meta.url),
    ),
  ).toString("utf8"),
) as {
  generatedFrom: {
    repository: string
    pullRequest: number
    sourceCircuit: string
    generator: string
    reduction: string
  }
  selectedBusIds: string[]
  connectedToSets: string[][]
  inputSrj: {
    obstacles: Array<Record<string, unknown> & { connectedToSetIndex: number }>
  } & Record<string, unknown>
  options: Record<string, unknown>
}

export const createAm62lDrillHoleClearanceRepro = () => {
  const inputSrj = {
    ...captured.inputSrj,
    obstacles: captured.inputSrj.obstacles.map(
      ({ connectedToSetIndex, ...obstacle }) => ({
        ...obstacle,
        connectedTo: captured.connectedToSets[connectedToSetIndex]!,
      }),
    ),
  } as unknown as ConstructorParameters<typeof FanoutSolver>[0]
  const options = captured.options as unknown as NonNullable<
    ConstructorParameters<typeof FanoutSolver>[1]
  >
  return structuredClone({
    generatedFrom: captured.generatedFrom,
    selectedBusIds: captured.selectedBusIds,
    inputSrj,
    options,
  })
}
