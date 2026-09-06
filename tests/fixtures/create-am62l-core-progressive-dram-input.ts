import type { FanoutSolver } from "../../lib/fanout-solver"
import captured from "./am62l-core-progressive-dram.json"

/** Reconstruct the exact DRAM-phase constructor arguments captured from core. */
export const createAm62lCoreProgressiveDramInput = () => {
  const inputSrj = {
    ...captured.inputSrj,
    obstacles: captured.inputSrj.obstacles.map(
      ({ connectedToSuffixIndex, ...obstacle }) => ({
        ...obstacle,
        connectedTo: [
          ...obstacle.connectedTo,
          ...(connectedToSuffixIndex === null
            ? []
            : captured.connectedToSuffixes[connectedToSuffixIndex]!),
        ],
      }),
    ),
  } as unknown as ConstructorParameters<typeof FanoutSolver>[0]
  const options = captured.options as unknown as NonNullable<
    ConstructorParameters<typeof FanoutSolver>[1]
  >
  return structuredClone({ inputSrj, options })
}
