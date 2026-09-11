import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { FanoutSolver } from "../../lib/fanout-solver"

const captured = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./am62l-direct-decoupling-dram-fanout.json.gz", import.meta.url),
    ),
  ).toString("utf8"),
) as {
  connectedToSets: string[][]
  inputSrj: {
    obstacles: Array<Record<string, unknown> & { connectedToSetIndex: number }>
  } & Record<string, unknown>
  options: Record<string, unknown>
}

/** Reconstruct the exact DRAM-phase input captured from the real Core TSX. */
export const createAm62lDirectDecouplingDramInput = () => {
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
  return structuredClone({ inputSrj, options })
}
