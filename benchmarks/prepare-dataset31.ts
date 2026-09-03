import { readFile } from "node:fs/promises"
import type { BenchmarkSample } from "./benchmark-types"

export async function prepareDataset31Samples(
  sampleIds: readonly string[],
  inputDirectory: string,
): Promise<BenchmarkSample[]> {
  // Keep core and the upstream solver dependency out of --list/--help and out
  // of timed workers. Workers always import this checkout's FanoutSolver.
  const { generateDataset31Inputs } = await import(
    "../scripts/generate-repro/generate-dataset31"
  )
  const paths = await generateDataset31Inputs(sampleIds, inputDirectory)
  return Promise.all(
    paths.map(async (path) => {
      const captured = JSON.parse(await readFile(path, "utf8"))
      return {
        dataset: "dataset31",
        id: captured.id,
        simpleRouteJson: captured.simpleRouteJson,
        solverOptions: captured.solverOptions,
      } satisfies BenchmarkSample
    }),
  )
}
